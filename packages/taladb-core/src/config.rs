//! TalaDB config loader.
//!
//! Parses and validates `taladb.config.yml` / `taladb.config.json`.
//! The config is available internally after `Phase 1` but drives no behaviour
//! until the HTTP sync adapter is wired in Phase 3.
//!
//! # File format
//!
//! ```yaml
//! sync:
//!   enabled: true
//!   endpoint: "https://api.example.com/taladb-events"
//!   headers:
//!     Authorization: "Bearer my-token"
//! ```
//!
//! or equivalently in JSON:
//!
//! ```json
//! {
//!   "sync": {
//!     "enabled": true,
//!     "endpoint": "https://api.example.com/taladb-events",
//!     "headers": { "Authorization": "Bearer my-token" }
//!   }
//! }
//! ```

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::TalaDbError;

// ---------------------------------------------------------------------------
// Config structs
// ---------------------------------------------------------------------------

/// HTTP push sync settings.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SyncConfig {
    /// Enable HTTP push sync. Defaults to `false` — everything is a no-op when
    /// disabled, so adding the config block without `enabled: true` is safe.
    #[serde(default)]
    pub enabled: bool,

    /// Default endpoint URL that receives all mutation events (`insert`, `update`,
    /// `delete`). Required when `enabled: true`; ignored otherwise.
    pub endpoint: Option<String>,

    /// HTTP headers sent with every outgoing request.
    /// Typical use: `Authorization: "Bearer <token>"`.
    #[serde(default)]
    pub headers: HashMap<String, String>,

    /// Override the endpoint for `insert` events only.
    pub insert_endpoint: Option<String>,

    /// Override the endpoint for `update` events only.
    pub update_endpoint: Option<String>,

    /// Override the endpoint for `delete` events only.
    pub delete_endpoint: Option<String>,

    /// Document fields to omit from every outgoing sync payload.
    ///
    /// Useful for stripping large computed fields such as embedding vectors
    /// that the remote endpoint doesn't need and shouldn't pay to transmit.
    ///
    /// Fields listed here are silently ignored if they are absent from the
    /// document — no error is raised.
    #[serde(default)]
    pub exclude_fields: Vec<String>,
}

/// Top-level TalaDB configuration (from `taladb.config.yml` / `taladb.config.json`).
///
/// Unknown top-level keys are silently ignored so future config additions are
/// backwards-compatible with older library versions.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct TalaDbConfig {
    /// HTTP push sync configuration. Disabled by default.
    #[serde(default)]
    pub sync: SyncConfig,
}

impl TalaDbConfig {
    /// Validate a parsed config.
    ///
    /// Checks that every endpoint URL (if present) is a well-formed HTTP or
    /// HTTPS URL. Returns `Err(TalaDbError::Config(...))` on the first invalid value.
    pub fn validate(&self) -> Result<(), TalaDbError> {
        for raw in [
            self.sync.endpoint.as_deref(),
            self.sync.insert_endpoint.as_deref(),
            self.sync.update_endpoint.as_deref(),
            self.sync.delete_endpoint.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            let parsed = url::Url::parse(raw).map_err(|e| {
                TalaDbError::Config(format!(
                    "invalid endpoint URL \"{raw}\" — {e}"
                ))
            })?;
            if parsed.scheme() != "http" && parsed.scheme() != "https" {
                return Err(TalaDbError::Config(format!(
                    "invalid endpoint URL \"{raw}\" — must start with http:// or https://"
                )));
            }
            if parsed.host().is_none() {
                return Err(TalaDbError::Config(format!(
                    "invalid endpoint URL \"{raw}\" — missing host"
                )));
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/// Load and validate a config from an explicit file path.
///
/// Supported extensions: `.yml`, `.yaml`, `.json`.
///
/// Returns `Err(TalaDbError::Config(...))` if the file cannot be read,
/// cannot be parsed, or fails validation.
pub fn load_from_path(path: &Path) -> Result<TalaDbConfig, TalaDbError> {
    let content = std::fs::read_to_string(path).map_err(|e| {
        TalaDbError::Config(format!("failed to read config at {}: {e}", path.display()))
    })?;

    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let config: TalaDbConfig = match ext {
        "yml" | "yaml" => serde_yaml::from_str(&content)
            .map_err(|e| TalaDbError::Config(format!("invalid YAML config: {e}")))?,
        "json" => serde_json::from_str(&content)
            .map_err(|e| TalaDbError::Config(format!("invalid JSON config: {e}")))?,
        other => {
            return Err(TalaDbError::Config(format!(
                "unsupported config extension \".{other}\" — use .yml, .yaml, or .json"
            )))
        }
    };

    config.validate()?;
    Ok(config)
}

/// Auto-discover a config from `cwd`.
///
/// Searches for `taladb.config.yml`, `taladb.config.yaml`, then
/// `taladb.config.json` (in that order) inside the given directory.
///
/// If no config file is found, returns a default (sync-disabled) config —
/// **not an error**. The database works normally without a config file.
pub fn load_auto(cwd: &Path) -> Result<TalaDbConfig, TalaDbError> {
    for name in [
        "taladb.config.yml",
        "taladb.config.yaml",
        "taladb.config.json",
    ] {
        let path = cwd.join(name);
        if path.exists() {
            return load_from_path(&path);
        }
    }
    Ok(TalaDbConfig::default())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::NamedTempFile;

    // ── parse helpers ────────────────────────────────────────────────────────

    fn write_tmp(content: &str, ext: &str) -> NamedTempFile {
        let mut f = tempfile::Builder::new()
            .suffix(&format!(".{ext}"))
            .tempfile()
            .unwrap();
        f.write_all(content.as_bytes()).unwrap();
        f
    }

    // ── YAML ─────────────────────────────────────────────────────────────────

    #[test]
    fn parses_valid_yaml() {
        let f = write_tmp(
            r#"
sync:
  enabled: true
  endpoint: "https://api.example.com/hook"
  headers:
    Authorization: "Bearer token123"
    X-Custom: "value"
"#,
            "yml",
        );
        let cfg = load_from_path(f.path()).unwrap();
        assert!(cfg.sync.enabled);
        assert_eq!(
            cfg.sync.endpoint.as_deref(),
            Some("https://api.example.com/hook")
        );
        assert_eq!(
            cfg.sync.headers.get("Authorization").map(String::as_str),
            Some("Bearer token123")
        );
        assert_eq!(
            cfg.sync.headers.get("X-Custom").map(String::as_str),
            Some("value")
        );
    }

    #[test]
    fn parses_yaml_with_yaml_extension() {
        let f = write_tmp("sync:\n  enabled: false\n", "yaml");
        let cfg = load_from_path(f.path()).unwrap();
        assert!(!cfg.sync.enabled);
    }

    #[test]
    fn parses_valid_json() {
        let f = write_tmp(
            r#"{
  "sync": {
    "enabled": true,
    "endpoint": "http://localhost:4000/events",
    "headers": { "Authorization": "Bearer tok" }
  }
}"#,
            "json",
        );
        let cfg = load_from_path(f.path()).unwrap();
        assert!(cfg.sync.enabled);
        assert_eq!(
            cfg.sync.endpoint.as_deref(),
            Some("http://localhost:4000/events")
        );
    }

    #[test]
    fn defaults_when_no_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = load_auto(dir.path()).unwrap();
        assert_eq!(cfg, TalaDbConfig::default());
        assert!(!cfg.sync.enabled);
    }

    #[test]
    fn load_auto_finds_yml_before_json() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("taladb.config.yml"),
            "sync:\n  enabled: true\n  endpoint: \"https://yml.example.com\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("taladb.config.json"),
            r#"{"sync":{"enabled":true,"endpoint":"https://json.example.com"}}"#,
        )
        .unwrap();
        let cfg = load_auto(dir.path()).unwrap();
        assert_eq!(
            cfg.sync.endpoint.as_deref(),
            Some("https://yml.example.com")
        );
    }

    #[test]
    fn ignores_unknown_keys() {
        let f = write_tmp(
            r#"
sync:
  enabled: false
unknown_top_level: "ignored"
"#,
            "yml",
        );
        // Should not error — unknown keys are silently ignored.
        assert!(load_from_path(f.path()).is_ok());
    }

    // ── validation ───────────────────────────────────────────────────────────

    #[test]
    fn rejects_non_http_endpoint() {
        let f = write_tmp(
            "sync:\n  enabled: true\n  endpoint: \"ftp://wrong.example.com\"\n",
            "yml",
        );
        let err = load_from_path(f.path()).unwrap_err();
        assert!(err.to_string().contains("invalid endpoint URL"));
    }

    #[test]
    fn rejects_relative_endpoint() {
        let f = write_tmp(
            "sync:\n  enabled: true\n  endpoint: \"/relative/path\"\n",
            "yml",
        );
        let err = load_from_path(f.path()).unwrap_err();
        assert!(err.to_string().contains("invalid endpoint URL"));
    }

    #[test]
    fn validates_per_event_endpoints() {
        let f = write_tmp(
            r#"
sync:
  enabled: true
  endpoint: "https://api.example.com/all"
  insert_endpoint: "not-a-url"
"#,
            "yml",
        );
        let err = load_from_path(f.path()).unwrap_err();
        assert!(err.to_string().contains("invalid endpoint URL"));
    }

    #[test]
    fn accepts_http_and_https_endpoints() {
        let cfg = TalaDbConfig {
            sync: SyncConfig {
                enabled: true,
                endpoint: Some("https://secure.example.com".into()),
                insert_endpoint: Some("http://localhost:3000/insert".into()),
                ..Default::default()
            },
        };
        assert!(cfg.validate().is_ok());
    }

    #[test]
    fn returns_error_on_unreadable_file() {
        let err = load_from_path(Path::new("/nonexistent/taladb.config.yml")).unwrap_err();
        assert!(err.to_string().contains("failed to read config"));
    }

    #[test]
    fn returns_error_on_unsupported_extension() {
        let f = write_tmp("sync:\n  enabled: true\n", "toml");
        let err = load_from_path(f.path()).unwrap_err();
        assert!(err.to_string().contains("unsupported config extension"));
    }

    #[test]
    fn parses_exclude_fields() {
        let f = write_tmp(
            r#"
sync:
  enabled: true
  endpoint: "https://api.example.com/events"
  exclude_fields:
    - embedding
    - clip_vector
    - internal_score
"#,
            "yml",
        );
        let cfg = load_from_path(f.path()).unwrap();
        assert_eq!(
            cfg.sync.exclude_fields,
            vec!["embedding", "clip_vector", "internal_score"]
        );
    }

    #[test]
    fn exclude_fields_defaults_to_empty() {
        let f = write_tmp(
            "sync:\n  enabled: true\n  endpoint: \"https://api.example.com\"\n",
            "yml",
        );
        let cfg = load_from_path(f.path()).unwrap();
        assert!(cfg.sync.exclude_fields.is_empty());
    }
}
