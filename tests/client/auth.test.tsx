import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../../client/src/App';
import { supabase } from '../../client/src/services/supabase';

jest.mock('../../client/src/services/supabase', () => ({
  supabase: {
    auth: {
      getSession: jest.fn(),
      onAuthStateChange: jest.fn(),
      signUp: jest.fn(),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
      resetPasswordForEmail: jest.fn(),
      updateUser: jest.fn(),
    },
  },
}));

jest.mock('../../client/src/services/api', () => ({
  fetchMe: jest.fn(),
  patchProfile: jest.fn(),
}));

const auth = supabase.auth as unknown as {
  getSession: jest.Mock;
  onAuthStateChange: jest.Mock;
};

describe('authentication flow', () => {
  it('redirects an unauthenticated user from / to /login and renders the login form', async () => {
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    auth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: jest.fn() } },
    });

    render(
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', { level: 1, name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });
});
