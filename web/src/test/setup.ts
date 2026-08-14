import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/* Vitest globals are off, so Testing Library's own auto-cleanup never registers
   itself. Unmounting between tests is what stops one test's effects — a
   reconnect timer, a request still in flight — running during the next. */
afterEach(cleanup);
