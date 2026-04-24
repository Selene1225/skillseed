---
scope: universal
sensitivity: public
category: good_practice
tags: [deployment, checklist, best-practice]
confidence: 1.0
source: import
created: "2025-01-01"
updated: "2025-01-01"
used: 0
---

Before deploying to production:
1. Run smoke tests in staging first
2. Check config diff between environments
3. Ensure database migrations are reversible
4. Verify rollback plan is ready
5. Notify the team in the deployment channel
6. Monitor metrics for 15 minutes after deploy
Never deploy on Fridays unless there is a critical fix.
