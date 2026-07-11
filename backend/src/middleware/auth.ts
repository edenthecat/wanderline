import { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
  }
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'editor';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function createAuthMiddleware(pool: Pool) {
  async function loadUser(req: Request): Promise<AuthUser | null> {
    if (!req.session?.userId) return null;

    // Cache on the request to avoid repeated DB lookups within the same request
    if (req.user) return req.user;

    const result = await pool.query(
      'SELECT id, email, display_name, role FROM users WHERE id = $1 AND is_active = true',
      [req.session.userId],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    req.user = {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
    };

    return req.user;
  }

  async function requireAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await loadUser(req);
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      next();
    } catch (error) {
      req.log.error({ err: error }, 'Auth middleware error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await loadUser(req);
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }
      if (user.role !== 'admin') {
        res.status(403).json({ error: 'Admin access required' });
        return;
      }
      next();
    } catch (error) {
      req.log.error({ err: error }, 'Admin middleware error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  async function requireProjectAccess(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await loadUser(req);
      if (!user) {
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      // Admins can access all projects
      if (user.role === 'admin') {
        next();
        return;
      }

      // The project ID comes from the route params - could be :id or :projectId
      const projectId = req.params.id || req.params.projectId;
      if (!projectId) {
        res.status(400).json({ error: 'Project ID required' });
        return;
      }

      const result = await pool.query(
        'SELECT 1 FROM project_collaborators WHERE project_id = $1 AND user_id = $2',
        [projectId, user.id],
      );

      if (result.rows.length === 0) {
        res.status(403).json({ error: 'Access denied to this project' });
        return;
      }

      next();
    } catch (error) {
      req.log.error({ err: error }, 'Project access middleware error');
      res.status(500).json({ error: 'Internal server error' });
    }
  }

  /**
   * Async predicate version of requireProjectAccess for non-Express
   * code paths (the collab WebSocket upgrade, background jobs).
   * Returns true if the user is an admin OR is a collaborator on the
   * project; false otherwise. The user must exist + be active.
   */
  async function canAccessProject(userId: string, projectId: string): Promise<boolean> {
    const userResult = await pool.query(
      'SELECT role FROM users WHERE id = $1 AND is_active = true',
      [userId],
    );
    if (userResult.rows.length === 0) return false;
    if (userResult.rows[0].role === 'admin') return true;
    const collabResult = await pool.query(
      'SELECT 1 FROM project_collaborators WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );
    return collabResult.rows.length > 0;
  }

  /**
   * In-handler owner-or-admin check for destructive operations.
   * Used by the routes that delete a project or manage collaborators.
   * Sends the response (403 / 500) itself; callers just early-return
   * on false. Optional errorMessage lets each caller keep its
   * context-specific 403 copy.
   */
  async function requireOwnerOrAdmin(
    req: Request,
    res: Response,
    projectId: string,
    errorMessage = 'Only project owners can perform this action',
  ): Promise<boolean> {
    try {
      const currentUser = req.user!;
      if (currentUser.role === 'admin') return true;
      const accessCheck = await pool.query(
        `SELECT role FROM project_collaborators WHERE project_id = $1 AND user_id = $2`,
        [projectId, currentUser.id],
      );
      if (accessCheck.rows[0]?.role === 'owner') return true;
      res.status(403).json({ error: errorMessage });
      return false;
    } catch (err) {
      req.log.error({ err }, 'Error checking owner access');
      res.status(500).json({ error: 'Failed to verify access' });
      return false;
    }
  }

  return {
    requireAuth,
    requireAdmin,
    requireProjectAccess,
    requireOwnerOrAdmin,
    canAccessProject,
  };
}
