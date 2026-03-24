use crate::engine::{StorageBackend, WriteTxn};
use crate::error::ZeroDbError;
use crate::index::{META_VERSION_KEY, META_VERSION_TABLE};

/// A single schema migration step.
pub struct Migration {
    pub from_version: u32,
    pub to_version: u32,
    pub description: &'static str,
    pub up: fn(&mut dyn WriteTxn) -> Result<(), ZeroDbError>,
}

/// Read the current database version (0 if unset).
pub fn read_version(txn: &dyn crate::engine::ReadTxn) -> Result<u32, ZeroDbError> {
    match txn.get(META_VERSION_TABLE, META_VERSION_KEY)? {
        Some(bytes) => Ok(postcard::from_bytes(&bytes)?),
        None => Ok(0),
    }
}

/// Write the current database version.
fn write_version(txn: &mut dyn WriteTxn, version: u32) -> Result<(), ZeroDbError> {
    let bytes = postcard::to_allocvec(&version)?;
    txn.put(META_VERSION_TABLE, META_VERSION_KEY, &bytes)?;
    Ok(())
}

/// Run all pending migrations in version order, each in its own write transaction.
/// Called at database open time before the handle is returned to the caller.
pub fn run_migrations(
    backend: &dyn StorageBackend,
    migrations: &[Migration],
) -> Result<(), ZeroDbError> {
    // Validate that migrations form a contiguous chain
    for pair in migrations.windows(2) {
        if pair[0].to_version != pair[1].from_version {
            return Err(ZeroDbError::Migration(format!(
                "migration gap: {} -> {} then {} -> {}",
                pair[0].from_version, pair[0].to_version,
                pair[1].from_version, pair[1].to_version,
            )));
        }
    }

    let rtxn = backend.begin_read()?;
    let current_version = read_version(rtxn.as_ref())?;
    drop(rtxn);

    for migration in migrations {
        if migration.from_version < current_version {
            continue; // already applied
        }
        if migration.from_version != current_version {
            return Err(ZeroDbError::Migration(format!(
                "migration out of order: db is at v{}, migration starts at v{}",
                current_version, migration.from_version
            )));
        }

        let mut wtxn = backend.begin_write()?;
        (migration.up)(wtxn.as_mut())?;
        write_version(wtxn.as_mut(), migration.to_version)?;
        wtxn.commit()?;
    }

    Ok(())
}
