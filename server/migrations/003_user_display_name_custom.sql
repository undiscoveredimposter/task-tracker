-- Let a person name themselves, and have it stick.
--
-- `requireAuth` reflects the Firebase identity into `users` on *every* request,
-- and its ON CONFLICT ... DO UPDATE writes `display_name` from the provider's
-- claims. So a name set through PATCH /api/me would otherwise survive exactly
-- until that person's next request — the feature would look like it worked and
-- then quietly undo itself.
--
-- This flag is the guard: once it is true, the upsert keeps the stored name and
-- the provider stops having an opinion. Defaults false, so every row that
-- already exists carries on following Google or whoever signed them in, until
-- its owner says otherwise.

ALTER TABLE users
  ADD COLUMN display_name_custom boolean NOT NULL DEFAULT false;
