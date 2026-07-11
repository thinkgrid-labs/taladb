// Shared row shapes. TalaDB documents carry a string `_id` plus your fields;
// the index signature satisfies the `Document` constraint the hooks are generic
// over. Remote rows are validated against these shapes on pull — never cast.

export interface Category {
  _id?: string;
  slug: string;
  name: string;
  blurb: string;
  [key: string]: string | number | undefined;
}

export interface Product {
  _id?: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  [key: string]: string | number | undefined;
}

export type OrderStatus = 'pending' | 'paid' | 'shipped';

export interface Order {
  _id?: string;
  ref: string;
  customer: string;
  total: number;
  status: OrderStatus;
  [key: string]: string | number | undefined;
}
