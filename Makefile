.PHONY: check check-identifiers check-secrets check-dashboard-links check-plugins hooks

# Deterministic local checks (same as the pre-push hook, plus a working-tree scan).
check: check-identifiers check-secrets check-dashboard-links

check-identifiers:
	scripts/check-identifiers.sh --all

# No link in a dashboard or kiosk view leaves the dashboard (AGENTS.md, "Dashboard and kiosk links").
check-dashboard-links:
	node scripts/check-dashboard-links.mjs
	node --test scripts/check-dashboard-links.test.mjs

check-secrets:
	gitleaks git --no-banner --redact
	gitleaks dir --no-banner --redact .

# Typecheck, lint and build every plugin (one at a time, memory bounded).
check-plugins:
	@for p in plugins/*/; do \
	  echo "== $$p"; \
	  (cd $$p && npm ci && npm run tsc && npm run lint && npm run build) || exit 1; \
	done

hooks:
	pre-commit install
