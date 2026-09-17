---
title: Session persistence
order: 13
---

Quitting the app does not kill your live sessions. A detached helper process
(`ptyKeeper`) holds open the same underlying pty file descriptor a session's
CLI process is writing to — closing the app's own reference alone would hang
up the terminal and kill the process within about a second, but a second
process holding that reference keeps it alive independent of whatever
happens to the app. The keeper drains the pty into a bounded backlog and
serves it over a Unix socket so a relaunched app can reattach: replay the
backlog, then live bytes, and send input back the same way.

The quit dialog (shown only when sessions are still live) is two buttons:
cancel, or quit — quitting always leaves every session running in the
background and reattaches them on next launch. There's no separate
kill-on-quit path anymore.
