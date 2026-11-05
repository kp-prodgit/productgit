# Draft a one-pager for SCIM sync

## Problem

Admins at multi-workspace customers keep user lists in sync by hand [T1], and requests are recurring [S1].

## Evidence

- Weekly CSV export as a workaround [T1]
- Third SCIM request this month [S1]

## Proposal

Add SCIM 2.0 user provisioning for SSO-enabled workspaces. Non-goals: group sync, custom attributes.

## Success metrics

- Time to add a workspace's users drops from hours to minutes.

## Open questions

- Which identity providers first?
