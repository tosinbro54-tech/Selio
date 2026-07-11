import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Create a safe, chainable Mock Proxy to prevent startup crashes when keys are missing
const createMockSupabase = () => {
  console.warn('[Supabase] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Falling back to mock client.');
  
  const handler: any = {
    get(target: any, prop: string): any {
      if (prop === 'then') {
        return undefined;
      }
      // Return a chainable proxy function
      const fn = () => {};
      return new Proxy(fn, {
        get(t: any, p: string) {
          if (p === 'then') {
            return (onfulfilled: any) => onfulfilled({ data: [], error: null });
          }
          return handler.get(t, p);
        },
        apply(targetApply: any, thisArg: any, argumentsList: any[]) {
          const innerObj = {};
          return new Proxy(innerObj, {
            get(tInner: any, pInner: string) {
              if (pInner === 'then') {
                return (onfulfilled: any) => onfulfilled({ data: [], error: null });
              }
              return handler.get(tInner, pInner);
            }
          });
        }
      });
    }
  };
  return new Proxy({}, handler) as any;
};

export const supabase = (supabaseUrl && supabaseAnonKey) 
  ? createClient(supabaseUrl, supabaseAnonKey)
  : createMockSupabase();

