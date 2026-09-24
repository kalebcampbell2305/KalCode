# ADR 0003 — Website on Cloudflare Workers with static assets

Status: accepted · 2026-09-24

## Context
kalcoded.com is managed in the owner's Cloudflare account. The site is mostly static, needs one
small API (early access), strict security headers, www→apex and HTTP→HTTPS redirects, and the
owner's credentials only allow Worker-level configuration (zone settings are read-only).

## Decision
Astro static build served by a Worker with the static-assets binding and `run_worker_first`, so
the Worker applies redirects and headers to every response. Early-access data in D1; abuse
controls via the Workers Rate Limiting binding. Custom domains attach both hostnames.

## Consequences
No separate hosting product, one deploy command, security headers in code (tested), no zone
configuration required. Every request invokes the Worker (well within free-tier limits at
current traffic).
