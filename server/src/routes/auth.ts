import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticate } from '../middleware/authenticate';
import { supabaseAdmin } from '../services/supabase';
import { updateProfileSchema } from '../validators';

function getAdmin(): SupabaseClient {
  if (!supabaseAdmin) {
    throw new Error('Supabase admin client is not configured.');
  }
  return supabaseAdmin;
}

export const authRouter = Router();

// Every route in this router operates on the authenticated user's own row.
authRouter.use(authenticate);

authRouter.get('/me', async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.id;
  const email = req.user?.email ?? null;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const admin = getAdmin();

    const { data: existing, error: selectError } = await admin
      .from('user_profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle();

    if (selectError) {
      next(selectError);
      return;
    }

    let profile = existing;

    if (!profile) {
      // Lazy-create the profile row if the trigger hasn't run yet (or the
      // row is otherwise missing), scoped to the authenticated user's own id.
      const { data: created, error: upsertError } = await admin
        .from('user_profiles')
        .upsert({ id: userId, email }, { onConflict: 'id' })
        .select('*')
        .maybeSingle();

      if (upsertError) {
        next(upsertError);
        return;
      }

      profile = created ?? null;
    }

    if (!profile) {
      next(new Error('Unable to load the user profile.'));
      return;
    }

    res.json({ user: { id: userId, email }, profile });
  } catch (error) {
    next(error);
  }
});

authRouter.patch('/profile', async (req: Request, res: Response, next: NextFunction) => {
  const userId = req.user?.id;
  const email = req.user?.email ?? null;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const parsed = updateProfileSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid request body',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const admin = getAdmin();

    // Upsert against the caller's own id only — never another user's row.
    const { data: updated, error } = await admin
      .from('user_profiles')
      .upsert({ id: userId, email, ...parsed.data }, { onConflict: 'id' })
      .select('*')
      .maybeSingle();

    if (error) {
      next(error);
      return;
    }

    if (!updated) {
      next(new Error('Unable to update the user profile.'));
      return;
    }

    res.json({ profile: updated });
  } catch (err) {
    next(err);
  }
});
