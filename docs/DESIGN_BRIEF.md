# Design brief — prompt for Claude design

Paste everything below the line into Claude design. It is deliberately self-contained: that session
won't have access to this repo, so the prompt carries its own context.

Implementation plan this feeds into: [`docs/PLAN.md`](./PLAN.md).

---

Design the UI for **a shared daily task tracker** — a checklist app for recurring household tasks
that more than one person is responsible for.

## The product

A household keeps a list of things that need doing every day: feed the cat, empty the dishwasher,
water the plants. Two or three people share that list. Anyone can tick a task off, and everyone
else sees it done — with who did it and when — within a second or two. Each day the list clears
itself and starts again. Some lists run on other cadences: weekly bins, monthly filter change,
every-3-days watering.

The problem it solves is small and domestic: *has anyone fed the cat, or am I about to feed her
twice?*

## Who uses it

Two to four people who live together, or a pet owner and their cat-sitter. Not a project team.
Nobody is at a desk — this is used one-handed, on a phone, usually while doing something else.
Ages and technical confidence vary; assume someone's dad is on this list.

## The interaction that matters

One person, one hand, 7am, half awake, ticking off the cat before leaving the house.

That tap must be effortless to find and satisfying to complete — big target, immediate response,
obvious result, and a way to undo it when they realise they tapped the wrong row. Everything else
in the app can be plain and quiet. Please spend your effort here.

## Hard constraints

- **React + Tailwind CSS.** Utility classes, standard Tailwind scale — the output gets translated
  into a real codebase, so avoid arbitrary values where a scale step exists.
- **Mobile-first at 375px wide.** Design that first. Then show how the list screen adapts on a
  tablet or desktop width.
- **Light and dark mode**, both properly considered — this gets opened at 6am and at 11pm.
- **Minimum 44×44px tap targets.** Primary actions within thumb reach at the bottom of the screen,
  not stranded in a top corner.
- **Installable PWA**, so it runs full-screen with no browser chrome. Account for iOS safe areas:
  content must clear the notch and the home indicator.
- **No external assets** — no icon CDNs, no remote images, no web fonts. Inline SVG and system font
  stack only.
- Accessible: real contrast ratios, visible focus states, and completion never signalled by colour
  alone.

## Screens

**1. Sign in.** Google button, email + password, and a "email me a sign-in link" option. One line
explaining what the app is for someone opening an invite link cold.

**2. Lists home.** A card per list showing emoji, name, progress (`3 of 5 done`), cadence, member
avatars, and time until it resets. Plus the empty state for a brand-new account, and a way to
create a list.

**3. List detail — the hero screen.** Header with progress and a reset countdown. A row per task:
large checkbox, title, and once done, who did it and when ("Alex · 8:12am"). Show *both* states
clearly — a done row and a not-done row must be distinguishable at a glance from across a kitchen.
Include: the moment just after tapping (with undo), an add-task action for people allowed to edit,
the empty state, and an offline banner for when the phone has no signal.

**4. Task editor.** A bottom sheet: title, optional notes, delete, and a drag handle for reordering.

**5. List settings.** Name, emoji, colour, timezone, and the cadence picker — daily / weekly /
monthly / every N days / never. Also a reset-hour picker, which needs a plain-language preview so
it's actually understandable: at 4am, *"resets at 4:00am — tasks done after midnight still count
for the previous day."*

**6. Share.** Choose a role (**viewer** can tick things off, **editor** can also add and delete
tasks), create an invite link, copy it — with a copied confirmation. Below: active invites with a
revoke action, and current members with their role and a remove action.

**7. Invite landing.** What the invited person sees when they open the link: "Alex invited you to
**Home**". Two variants — signed out (sign in first) and signed in (join now) — plus the failure
states: expired, revoked, already a member.

**8. Stats.** Who did what over the last 7 and 30 days, current streak, completion rate. Keep this
friendly and non-judgemental — it should never feel like a leaderboard for shaming a flatmate.

**9. System states.** Loading skeletons, a general error, offline, the PWA install prompt, and the
iOS "add to home screen" hint (Safari gives no install button, so it must be explained).

## Sample content — please use this, not placeholder text

- **Home** 🏠 — daily, resets 4am. Feed the cat · Empty the dishwasher · Water the plants ·
  Take the bins out · Check the post. Members: Alex (owner), Sam (editor), Jo (viewer).
- **Flat admin** 📋 — weekly. Hoover the hallway · Clean the bathroom.
- **Plants** 🪴 — every 3 days. Water the ferns.

Around 8am, three of the five Home tasks are done: the cat by Sam, the dishwasher by Alex, the post
by Alex.

## Tone

Warm and domestic, not corporate productivity software. This app lives next to a fridge magnet and
a shopping list, not next to a sprint board. Calm, legible, a little charming — but never at the
cost of being instantly readable while half asleep. Restraint over decoration.

## Deliver

A single interactive React artifact containing all the screens, with a picker to move between them
and a light/dark toggle, rendered inside a phone frame at 375px. Include one desktop-width view of
the list screen. State your colour tokens, type scale, and spacing rhythm explicitly somewhere in
the artifact, so they can be lifted straight into the build.

## Out of scope

No marketing site, no onboarding carousel, no notification settings, no calendar or scheduling
views, no per-task assignment to a specific person — a task belongs to the household, and whoever
gets to it first ticks it.
