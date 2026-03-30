// ============================================================
// TalaDB — Shared TypeScript Types
// ============================================================

export type Value =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | Value[]
  | { [key: string]: Value };

export type Document = { _id?: string; [key: string]: Value | undefined };

// --------------- Filter DSL ---------------

type FieldOps<T> = T extends null | undefined
  ? { $exists?: boolean }
  : {
      $eq?: T;
      $ne?: T;
      $gt?: T;
      $gte?: T;
      $lt?: T;
      $lte?: T;
      $in?: T[];
      $nin?: T[];
      $exists?: boolean;
      /** Full-text search: matches documents where this string field contains the given token. */
      $contains?: string;
    };

export type Filter<T extends Document = Document> = {
  [K in keyof T]?: T[K] | FieldOps<T[K]>;
} & {
  $and?: Filter<T>[];
  $or?: Filter<T>[];
  $not?: Filter<T>;
};

// --------------- Update DSL ---------------

export type Update<T extends Document = Document> = {
  $set?: Partial<T>;
  $unset?: { [K in keyof T]?: true };
  $inc?: { [K in keyof T]?: number };
  $push?: { [K in keyof T]?: Value };
  $pull?: { [K in keyof T]?: Value };
};

// --------------- Collection interface ---------------

export interface Collection<T extends Document = Document> {
  insert(doc: Omit<T, '_id'>): Promise<string>;
  insertMany(docs: Omit<T, '_id'>[]): Promise<string[]>;
  find(filter?: Filter<T>): Promise<T[]>;
  findOne(filter: Filter<T>): Promise<T | null>;
  updateOne(filter: Filter<T>, update: Update<T>): Promise<boolean>;
  updateMany(filter: Filter<T>, update: Update<T>): Promise<number>;
  deleteOne(filter: Filter<T>): Promise<boolean>;
  deleteMany(filter: Filter<T>): Promise<number>;
  count(filter?: Filter<T>): Promise<number>;
  createIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  dropIndex(field: keyof Omit<T, '_id'> & string): Promise<void>;
  /**
   * Subscribe to live query results. The callback receives a full snapshot of
   * matching documents immediately and again after every write that could
   * affect the result set.
   *
   * @returns An unsubscribe function. Call it to stop receiving updates.
   *
   * @example
   * const unsub = users.subscribe({ active: true }, (docs) => {
   *   console.log('active users:', docs);
   * });
   * // later…
   * unsub();
   */
  subscribe(filter: Filter<T>, callback: (docs: T[]) => void): () => void;
}

// --------------- TalaDB interface ---------------

export interface TalaDB {
  collection<T extends Document = Document>(name: string): Collection<T>;
  close(): Promise<void>;
}
