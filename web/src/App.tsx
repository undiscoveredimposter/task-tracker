import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { DataProvider, useData } from './lib/store';
import { InstallPrompt } from './components/InstallPrompt';
import { EmptyState, ListSkeleton } from './components/ui';
import { Invite } from './screens/Invite';
import { ListDetail } from './screens/ListDetail';
import { ListSettings } from './screens/ListSettings';
import { Lists } from './screens/Lists';
import { Share } from './screens/Share';
import { SignIn } from './screens/SignIn';
import { Stats } from './screens/Stats';

/** Anything behind sign-in. Invite links are deliberately not in here. */
function Protected({ children }: { children: React.ReactNode }) {
  const { loading, me, error } = useAuth();

  if (loading) return <ListSkeleton />;

  if (error && !me) {
    return (
      <EmptyState title="Tally isn't set up yet">
        {error} Check the Firebase build variables and redeploy.
      </EmptyState>
    );
  }

  return me ? <>{children}</> : <SignIn />;
}

/** A whole-app error line, for failures that aren't tied to one screen. */
function ErrorBanner() {
  const { error } = useData();
  if (!error) return null;
  return (
    <div role="alert" className="fixed inset-x-4 top-[calc(env(safe-area-inset-top)+8px)] z-40 rounded-xl bg-danger/15 px-4 py-2.5 text-sm text-danger">
      {error}
    </div>
  );
}

function Shell() {
  const location = useLocation();
  // The desktop layout caps the column so rows stay scannable; on a phone this
  // is simply the full width.
  const wide = location.pathname === '/';

  return (
    <div className="mx-auto h-full w-full max-w-2xl" data-wide={wide}>
      <ErrorBanner />
      <Routes>
        <Route path="/j/:token" element={<Invite />} />
        <Route
          path="/"
          element={
            <Protected>
              <Lists />
            </Protected>
          }
        />
        <Route
          path="/l/:id"
          element={
            <Protected>
              <ListDetail />
            </Protected>
          }
        />
        <Route
          path="/l/:id/settings"
          element={
            <Protected>
              <ListSettings />
            </Protected>
          }
        />
        <Route
          path="/l/:id/share"
          element={
            <Protected>
              <Share />
            </Protected>
          }
        />
        <Route
          path="/l/:id/stats"
          element={
            <Protected>
              <Stats />
            </Protected>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <InstallPrompt />
    </div>
  );
}

export function App() {
  return (
    <Router>
      <AuthProvider>
        <DataProvider>
          <Shell />
        </DataProvider>
      </AuthProvider>
    </Router>
  );
}
