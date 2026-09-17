// src/lib/auth.ts
import { createContext, useContext, useEffect, useState } from "react";
import { getAuth, onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import { reminderContextManager } from "./reminder-context";

export type AuthState = 
  | { status: 'loading' }
  | { status: 'authenticated'; user: User }
  | { status: 'unauthenticated' }
  | { status: 'error'; error: Error };

const AuthContext = createContext<AuthState>({ status: 'loading' });

let bootstrapPromise: Promise<User | null> | null = null;
let bootstrapAttempted = false;

/**
 * Returns the current authenticated Firebase user, awaiting any in-flight
 * anonymous authentication bootstrap if one is currently in progress.
 */
export async function ensureAuthenticatedUser(): Promise<User | null> {
  const auth = getAuth();
  if (auth.currentUser) return auth.currentUser;
  if (bootstrapPromise) {
    try {
      return await bootstrapPromise;
    } catch {
      return null;
    }
  }
  return null;
}

export function _resetAuthBootstrapForTesting(): void {
  bootstrapPromise = null;
  bootstrapAttempted = false;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let isMounted = true;
    const auth = getAuth();

    const unsubscribe = onAuthStateChanged(
      auth,
      async (user) => {
        if (!isMounted) return;

        if (user) {
          bootstrapAttempted = true;
          if (reminderContextManager.getContext(user.uid) === null) {
            reminderContextManager.clear();
          }
          setState({ status: 'authenticated', user });
        } else {
          // User is null: if we have not yet attempted anonymous bootstrap, do it now
          if (!bootstrapAttempted) {
            bootstrapAttempted = true;
            try {
              if (!bootstrapPromise) {
                bootstrapPromise = signInAnonymously(auth).then((cred) => cred.user);
              }
              const anonUser = await bootstrapPromise;
              if (isMounted) {
                if (anonUser) {
                  if (reminderContextManager.getContext(anonUser.uid) === null) {
                    reminderContextManager.clear();
                  }
                  setState({ status: 'authenticated', user: anonUser });
                } else {
                  reminderContextManager.clear();
                  setState({ status: 'unauthenticated' });
                }
              }
            } catch (err: any) {
              if (isMounted) {
                reminderContextManager.clear();
                const message =
                  err?.code === 'auth/operation-not-allowed' || err?.code === 'auth/admin-restricted-operation'
                    ? 'Anonymous sign-in is disabled in the Firebase Console. Enable it under Firebase Console -> Authentication -> Sign-in method -> Anonymous.'
                    : err?.message || 'Authentication bootstrap failed';
                setState({ status: 'error', error: new Error(message) });
              }
            } finally {
              bootstrapPromise = null;
            }
          } else {
            // Already bootstrapped and user is legitimately null (e.g. sign out)
            reminderContextManager.clear();
            setState({ status: 'unauthenticated' });
          }
        }
      },
      (error) => {
        if (isMounted) {
          setState({ status: 'error', error });
        }
      }
    );

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}

