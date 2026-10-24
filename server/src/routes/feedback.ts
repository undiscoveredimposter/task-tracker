import { Router } from 'express';
import { config } from '../config.js';
import { HttpError } from '../errors.js';
import {
  createFeedbackSchema,
  FeedbackDeliveryError,
  openGitHubIssue,
  renderFeedbackIssue,
} from '../feedback.js';

/**
 * `POST /api/feedback` — the form behind the icon at the top of the app. Turns
 * what somebody wrote into a GitHub issue; feedback.ts decides what that issue
 * says. Nothing is stored here: the issue is the record.
 */
export const feedbackRouter: Router = Router();

feedbackRouter.post('/', async (req, res) => {
  const input = createFeedbackSchema.parse(req.body);

  const { githubToken, repo } = config.feedback;
  if (!githubToken) {
    throw new HttpError(503, "Feedback isn't set up on this server yet.", 'feedback_unconfigured');
  }

  try {
    await openGitHubIssue({ token: githubToken, repo }, renderFeedbackIssue(input, new Date()));
  } catch (error) {
    if (error instanceof FeedbackDeliveryError) {
      throw new HttpError(502, "Your feedback couldn't be sent just now. Try again in a bit.");
    }
    throw error;
  }
  res.status(204).end();
});
