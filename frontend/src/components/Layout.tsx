import { Outlet, Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <div className="layout">
      <header className="header">
        <div className="header-left">
          <Link to="/" className="header-logo">
            Wanderline
          </Link>
          {user?.role === 'admin' && (
            <Link to="/users" className="header-nav-link">
              Users
            </Link>
          )}
        </div>
        {user && (
          <div className="header-right">
            <span
              className="header-user"
              aria-label={`Signed in as ${user.displayName}, role ${user.role}`}
            >
              <span className="header-user-name">{user.displayName}</span>
              <span className="header-role" aria-hidden="true">
                {user.role}
              </span>
            </span>
            <button onClick={handleLogout} className="btn btn-ghost btn-sm">
              Log out
            </button>
          </div>
        )}
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
