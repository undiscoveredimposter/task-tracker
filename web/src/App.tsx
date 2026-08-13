import { Navigate, Route, BrowserRouter as Router, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { DataProvider, useData } from './lib/store';
import { DesktopSidebar, DesktopTopBar } from './components/DesktopChrome';
import { InstallPrompt } from './components/InstallPrompt';
import { UpdateBar } from './components/UpdateBar';
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
  const { loading, me, error, firebaseUser } = useAuth();

  if (loading) return <ListSkeleton />;

  if (error && !me) {
    // Firebase having handed us a user means the build is configured — it
    // verified a session. So the failure is our API not answering, and telling
    // someone in a basement to check their build variables is nonsense. Without
    // a firebaseUser the config advice is the right advice.
    return firebaseUser ? (
      <EmptyState title="Nothing saved on this device">
        {error}. Your lists will be here once Tally can reach the server again.
      </EmptyState>
    ) : (
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
  const { me } = useAuth();
  const location = useLocation();
  // Sign-in and an invite landing are pages in their own right — someone who
  // isn't a member yet has no lists to put in a sidebar.
  const chrome = Boolean(me) && !location.pathname.startsWith('/j/');

  return (
    <div className="flex h-full flex-col">
      {chrome && <DesktopTopBar />}
      <div className="flex min-h-0 flex-1">
        {chrome && <DesktopSidebar />}
        {/* The column is capped so a row never stretches to the far edge of a
            laptop; on a phone this is simply the full width. */}
        <main className="mx-auto flex h-full w-full max-w-[680px] min-w-0 flex-1 flex-col">
          <ErrorBanner />
          {/* The screen takes whatever the update bar leaves, which is all of it
              until there is something to say. */}
          <div className="min-h-0 flex-1">
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
          </div>
          <UpdateBar />
          <InstallPrompt />
        </main>
      </div>
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
