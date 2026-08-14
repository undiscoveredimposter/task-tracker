import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/* Vitest globals are off, so Testing Library's own auto-cleanup never registers
   itself. Unmounting between tests is what stops one test's effects — a
   reconnect timer, a request still in flight — running during the next. */
afterEach(cleanup);

/* jsdom parses <dialog> but implements none of its methods, so `Sheet` — which
   is a real modal dialog — throws the moment it mounts and nothing built on one
   is testable at all.

   The shim is only the part the assertions rest on: `open`, which is what makes
   the dialog and its contents visible to a role query. The top layer, the
   backdrop, the focus trap and Escape are the browser's and stay the browser's;
   no test here claims anything about them. */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
}
