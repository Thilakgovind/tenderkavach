import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export function AuthButton() {
  const [user, setUser] = useState<User | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const signIn = async () => {
    if (!supabase) {
      setMessage('Sign-in will be enabled when Supabase browser settings are added.');
      return;
    }
    const email = window.prompt('Enter your business email')?.trim();
    if (!email) return;
    setMessage('Sending your secure sign-in link…');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    setMessage(error ? 'Could not send sign-in link. Check the email and try again.' : 'Check your email to continue.');
  };

  const signOut = async () => {
    await supabase?.auth.signOut();
    setMessage('Signed out.');
  };

  return (
    <div className="relative">
      <button type="button" onClick={user ? signOut : signIn} className="nav-lang-btn" aria-label={user ? 'Sign out' : 'Sign in'}>
        {user ? 'Sign out' : 'Sign in'}
      </button>
      {message && <p className="absolute right-0 top-full mt-2 w-52 rounded-lg border border-white/15 bg-[#12101a] p-2 text-[10px] text-white/80 shadow-xl">{message}</p>}
      {!isSupabaseConfigured() && <span className="sr-only">Supabase is not configured.</span>}
    </div>
  );
}
