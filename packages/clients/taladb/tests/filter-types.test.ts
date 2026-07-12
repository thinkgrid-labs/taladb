import { describe, it, expect } from 'vitest';
import type { Document, Filter } from '../src/types';

/**
 * Type-level regression tests. These assert nothing at runtime — the value is
 * that `tsc` fails if the `Filter`/`FieldOps` inference regresses. Each block
 * below failed to compile before `FieldOps` stopped being a distributive
 * conditional.
 */

type ListingType = 'Apartment' | 'House' | 'Villa' | 'Cabin';

interface Listing extends Document {
  slug: string;
  type: ListingType; // a union-typed field — the whole point
  pricePerNight: number;
  rating?: number; // optional — must still get `$exists`
  tags?: string[];
}

describe('Filter type inference', () => {
  it('allows $in on a union-typed field', () => {
    // Previously inferred `$in?: 'Apartment'[] | 'House'[] | …` because
    // `FieldOps<T>` distributed over the union, so this needed an `as` cast.
    const f: Filter<Listing> = { type: { $in: ['Cabin', 'Villa'] } };
    expect(f).toBeTruthy();
  });

  it('allows a bare equality on a union-typed field', () => {
    const f: Filter<Listing> = { type: 'Villa' };
    expect(f).toBeTruthy();
  });

  it('allows $eq/$ne on a union-typed field', () => {
    const f: Filter<Listing> = { type: { $ne: 'House' } };
    expect(f).toBeTruthy();
  });

  it('still rejects a value outside the union', () => {
    // @ts-expect-error 'Castle' is not a ListingType
    const f: Filter<Listing> = { type: { $in: ['Castle'] } };
    expect(f).toBeTruthy();
  });

  it('keeps $exists available on an optional field', () => {
    // The distributive conditional existed to provide this; the non-distributive
    // rewrite must not lose it.
    const f: Filter<Listing> = { rating: { $exists: false } };
    expect(f).toBeTruthy();
  });

  it('compares an optional field against its non-null type', () => {
    const f: Filter<Listing> = { rating: { $gte: 4.5 } };
    expect(f).toBeTruthy();
  });

  it('supports range operators on numbers', () => {
    const f: Filter<Listing> = { pricePerNight: { $gte: 50, $lte: 300 } };
    expect(f).toBeTruthy();
  });

  it('supports $and with union-typed clauses, uncast', () => {
    const f: Filter<Listing> = {
      $and: [{ type: { $in: ['Cabin'] } }, { pricePerNight: { $lte: 200 } }],
    };
    expect(f).toBeTruthy();
  });
});
