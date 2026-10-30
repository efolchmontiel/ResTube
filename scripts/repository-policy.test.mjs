// @vitest-environment node
/** Deterministic tests for .github/scripts/issue-policy.mjs (no network, no real GitHub writes).
 *  Every scenario exercises the public runPolicy entry with a stubbed Octokit API only.
 *  Assertions observe label changes, commit statuses, and route usage — never internal state. */
import { describe, expect, it } from 'vitest';
import { extractLinkedIssueRefs, runPolicy, STATUS_CONTEXT } from '../.github/scripts/issue-policy.mjs';

const OWNER = { login: 'efolchmontiel', id: 22103249 };
const OUTSIDER = { login: 'random-contributor', id: 9999 };

const context = (eventName, extra = {}) => ({
  eventName,
  repo: { owner: OWNER.login, repo: 'ResTube' },
  payload: { repository: { default_branch: 'main', owner: { login: OWNER.login }, name: 'ResTube' }, ...extra },
});

const runOpts = (octokit, eventName, extra = {}) => ({
  octokit,
  context: context(eventName, extra),
  config: { runUrl: 'https://github.com/efolchmontiel/ResTube/actions/runs/42' },
  log: () => {},
});

// ---------------------------------------------------------------- fixtures

const asLabels = (names) => names.map((name) => ({ name }));
const makeIssue = (number, { labels = [], state = 'open', pullRequest = false } = {}) => ({
  number,
  state,
  title: `Issue ${number}`,
  body: `Body of issue ${number} <script>alert(1)</script>`,
  labels: asLabels(labels),
  ...(pullRequest ? { pull_request: { url: 'x' } } : {}),
});
const makePull = (number, { body = '', headSha } = {}) => ({
  number,
  state: 'open',
  title: `PR ${number}`,
  body,
  head: { sha: headSha ?? `sha-${number}` },
  pull_request: { url: 'x' },
});
const approvalEvent = (id, actor, label = 'status:approved') => ({
  id,
  event: 'labeled',
  label: { name: label },
  actor: { id: actor.id, login: actor.login },
});

function buildStub({ issues = [], pulls = [], pullDetail = {}, branch = null, events = {} } = {}) {
  const calls = { request: [], statuses: [], added: [], removed: [] };
  const octokit = {
    paginate: async (route, params = {}) => {
      calls.request.push({ route, params });
      if (route === 'GET /repos/{owner}/{repo}/issues') return issues;
      if (route === 'GET /repos/{owner}/{repo}/pulls') return pulls;
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/events') return events[params.issue_number] ?? [];
      throw new Error(`unexpected paginate route: ${route}`);
    },
    request: async (route, params = {}) => {
      calls.request.push({ route, params });
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
        const pr = pullDetail[params.pull_number] ?? pulls.find((p) => p.number === params.pull_number);
        if (!pr) throw notFound();
        return { data: pr };
      }
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') {
        const issue = issues.find((i) => i.number === params.issue_number && !i.pull_request);
        if (!issue) throw notFound();
        return { data: issue };
      }
      if (route === 'POST /repos/{owner}/{repo}/statuses/{sha}') {
        calls.statuses.push({ sha: params.sha, state: params.state, context: params.context, description: params.description, target_url: params.target_url });
        return { data: {} };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels') {
        calls.added.push({ number: params.issue_number, labels: params.labels });
        return { data: {} };
      }
      if (route === 'DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}') {
        calls.removed.push({ number: params.issue_number, name: params.name });
        return { data: {} };
      }
      if (route === 'GET /repos/{owner}/{repo}/branches/{branch}') {
        if (!branch) throw new Error('no branch fixture');
        return { data: branch };
      }
      throw new Error(`unexpected request route: ${route}`);
    },
  };
  return { octokit, calls };
}

function notFound() {
  const error = new Error('Not Found');
  error.status = 404;
  return error;
}
function serverError() {
  const error = new Error('Internal Server Error');
  error.status = 500;
  return error;
}

const statusFor = (calls, sha) => calls.statuses.filter((s) => s.sha === sha);
const finalStatus = (calls, sha) => statusFor(calls, sha).at(-1);

// ---------------------------------------------------------------- label normalization

describe('issue label normalization (S4)', () => {
  it('adds status:triage to an open issue with no status label', async () => {
    const { octokit, calls } = buildStub({ issues: [makeIssue(1, { labels: ['type:bug'] })] });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.added).toEqual([{ number: 1, labels: ['status:triage'] }]);
    expect(calls.removed).toEqual([]);
    expect(calls.statuses).toEqual([]);
  });

  it('adds status:triage to an open issue with no labels at all', async () => {
    const { octokit, calls } = buildStub({ issues: [makeIssue(2, { labels: [] })] });
    await runPolicy(runOpts(octokit, 'issues', { action: 'opened' }));
    expect(calls.added).toEqual([{ number: 2, labels: ['status:triage'] }]);
  });

  it('removes status:triage once an owner approval is verified through label events', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(3, { labels: ['status:triage', 'status:approved'] })],
      events: { 3: [approvalEvent(1, OUTSIDER, 'type:bug'), approvalEvent(2, OWNER)] },
    });
    await runPolicy(runOpts(octokit, 'issues', { action: 'labeled' }));
    expect(calls.removed).toEqual([{ number: 3, name: 'status:triage' }]);
    expect(calls.added).toEqual([]);
  });

  it('removes a forged status:approved and restores status:triage when the latest approval event is not the owner', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(4, { labels: ['status:approved'] })],
      events: { 4: [approvalEvent(1, OWNER), approvalEvent(2, OUTSIDER)] },
    });
    await runPolicy(runOpts(octokit, 'issues', { action: 'labeled' }));
    expect(calls.removed).toEqual([{ number: 4, name: 'status:approved' }]);
    expect(calls.added).toEqual([{ number: 4, labels: ['status:triage'] }]);
  });

  it('treats a status:approved label with no approval event as unapproved and normalizes it', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(5, { labels: ['status:approved'] })],
      events: { 5: [] },
    });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.removed).toEqual([{ number: 5, name: 'status:approved' }]);
    expect(calls.added).toEqual([{ number: 5, labels: ['status:triage'] }]);
  });

  it('verifies approval by owner account ID, never by login string alone', async () => {
    const fakeLoginOwner = { login: 'efolchmontiel', id: 4242 };
    const { octokit, calls } = buildStub({
      issues: [makeIssue(6, { labels: ['status:approved'] })],
      events: { 6: [approvalEvent(1, fakeLoginOwner)] },
    });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.removed).toEqual([{ number: 6, name: 'status:approved' }]);
    expect(calls.added).toEqual([{ number: 6, labels: ['status:triage'] }]);
  });

  it('skips pull requests found in the issues listing (they are reconciled by the PR gate)', async () => {
    const { octokit, calls } = buildStub({ issues: [makeIssue(7, { labels: [], pullRequest: true })] });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.added).toEqual([]);
  });

  it('never grants status:approval by itself in any normalization scenario', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(8, { labels: [] }), makeIssue(9, { labels: ['status:approved'] })],
      events: { 9: [approvalEvent(1, OWNER)] },
    });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.added.every((a) => !a.labels.includes('status:approved'))).toBe(true);
  });
});

// ---------------------------------------------------------------- PR gate (S5)

describe('pull request approval gate (S5)', () => {
  it('marks a PR with a same-repo owner-approved linked issue as success and never closes it', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(10, { labels: ['type:bug', 'status:approved'] })],
      events: { 10: [approvalEvent(1, OWNER)] },
      pulls: [makePull(20, { body: 'Refs #10' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target', { action: 'opened' }));
    const sha = 'sha-20';
    expect(statusFor(calls, sha).map((s) => s.state)).toEqual(['pending', 'success']);
    const final = finalStatus(calls, sha);
    expect(final.context).toBe(STATUS_CONTEXT);
    expect(final.context).toBe('Issue approval gate');
    expect(final.target_url).toBe('https://github.com/efolchmontiel/ResTube/actions/runs/42');
    expect(calls.request.every((c) => !c.route.startsWith('PATCH'))).toBe(true);
  });

  it('accepts every explicit keyword form and canonical same-repo issue URLs', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(10, { labels: ['status:approved'] }), makeIssue(11, { labels: ['status:approved'] })],
      events: { 10: [approvalEvent(1, OWNER)], 11: [approvalEvent(2, OWNER)] },
      pulls: [makePull(21, { body: `Closes #10\nhttps://github.com/efolchmontiel/ResTube/issues/11` })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    expect(finalStatus(calls, 'sha-21').state).toBe('success');
  });

  it('fails a PR with no linked issue', async () => {
    const { octokit, calls } = buildStub({ pulls: [makePull(22, { body: 'Just a change.' })] });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    const final = finalStatus(calls, 'sha-22');
    expect(final.state).toBe('failure');
    expect(final.context).toBe(STATUS_CONTEXT);
    expect(final.description.toLowerCase()).toContain('no linked issue');
  });

  it('fails a PR whose linked issue is unapproved, unlabeled, or not found', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(30, { labels: ['type:bug'] })],
      events: {},
      pulls: [makePull(31, { body: 'Fixes #30' }), makePull(32, { body: 'Fixes #3999' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    expect(finalStatus(calls, 'sha-31').state).toBe('failure');
    expect(finalStatus(calls, 'sha-31').description).toContain('#30');
    expect(finalStatus(calls, 'sha-32').state).toBe('failure');
  });

  it('rejects a PR linked to another pull request (PR-as-issue)', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(40, { labels: ['status:approved'], pullRequest: true })],
      events: { 40: [approvalEvent(1, OWNER)] },
      pulls: [makePull(41, { body: 'Closes #40' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    expect(finalStatus(calls, 'sha-41').state).toBe('failure');
    expect(finalStatus(calls, 'sha-41').description).toContain('#40');
  });

  it('ignores cross-repo issue URLs and bare numbers without a linking keyword', async () => {
    const { octokit, calls } = buildStub({
      pulls: [makePull(50, { body: 'See https://github.com/other/other/issues/1 and #7 for context' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    const final = finalStatus(calls, 'sha-50');
    expect(final.state).toBe('failure');
    expect(final.description.toLowerCase()).toContain('no linked issue');
  });

  it('ignores references written inside code blocks', async () => {
    const { octokit, calls } = buildStub({
      pulls: [makePull(51, { body: 'Example:\n```\nCloses #1\n```' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    expect(finalStatus(calls, 'sha-51').state).toBe('failure');
  });

  it('requires ALL linked issues to be eligible (fail closed), not any one', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(60, { labels: ['status:approved'] }), makeIssue(61, { labels: ['type:bug'] })],
      events: { 60: [approvalEvent(1, OWNER)] },
      pulls: [makePull(62, { body: 'Fixes #60\nFixes #61' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    const final = finalStatus(calls, 'sha-62');
    expect(final.state).toBe('failure');
    expect(final.description).toContain('#61');
  });

  it('revalidates against fresh head SHA and body, not the event payload snapshot', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(70, { labels: ['status:approved'] })],
      events: { 70: [approvalEvent(1, OWNER)] },
      pulls: [makePull(71, { headSha: 'stale-head' })],
      pullDetail: { 71: makePull(71, { headSha: 'fresh-head', body: 'Refs #70' }) },
    });
    await runPolicy(runOpts(octokit, 'pull_request_target', { action: 'synchronize' }));
    expect(statusFor(calls, 'fresh-head').map((s) => s.state)).toEqual(['pending', 'success']);
    expect(calls.statuses.every((s) => s.sha !== 'stale-head')).toBe(true);
  });

  it('flips a previously approved PR to failure in the same run after approval revocation', async () => {
    const { octokit, calls } = buildStub({
      // current label state: approval revoked (label is gone now)
      issues: [makeIssue(80, { labels: ['status:triage'] })],
      events: { 80: [approvalEvent(1, OWNER)] },
      pulls: [makePull(81, { body: 'Refs #80' })],
    });
    await runPolicy(runOpts(octokit, 'issues', { action: 'unlabeled' }));
    expect(finalStatus(calls, 'sha-81').state).toBe('failure');
  });

  it('fails closed on API errors: rejects the run and never posts success', async () => {
    const failing = buildStub({
      issues: [makeIssue(90, { labels: ['status:approved'] })],
      events: { 90: [approvalEvent(1, OWNER)] },
      pulls: [makePull(91, { body: 'Refs #90' })],
    });
    const originalRequest = failing.octokit.request;
    failing.octokit.request = async (route, params) => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}') throw serverError();
      return originalRequest(route, params);
    };
    await expect(runPolicy(runOpts(failing.octokit, 'pull_request_target'))).rejects.toThrow();
    const posted = statusFor(failing.calls, 'sha-91');
    expect(posted.map((s) => s.state)).toEqual(['pending', 'failure']);
    expect(failing.calls.statuses.every((s) => s.state !== 'success')).toBe(true);
  });

  it('rejects a PR linked to an issue the owner never approved, with a closed human-readable reason', async () => {
    const { octokit, calls } = buildStub({
      issues: [makeIssue(95, { labels: ['status:approved'] })],
      events: { 95: [approvalEvent(1, OUTSIDER)] },
      pulls: [makePull(96, { body: 'Refs #95' })],
    });
    await runPolicy(runOpts(octokit, 'pull_request_target'));
    const final = finalStatus(calls, 'sha-96');
    expect(final.state).toBe('failure');
    expect(final.description.length).toBeLessThanOrEqual(140);
    expect(final.description).not.toMatch(/Internal Server Error|Exception|at /);
  });
});

// ---------------------------------------------------------------- pagination, readiness, safety

describe('pagination, readiness and safety rails', () => {
  it('reconciles every issue beyond the first page (no silent truncation at 100)', async () => {
    const issues = Array.from({ length: 150 }, (_, i) => makeIssue(i + 1, { labels: [] }));
    const { octokit, calls } = buildStub({ issues, branch: { commit: { sha: 'main-head-sha' } } });
    await runPolicy(runOpts(octokit, 'workflow_dispatch'));
    expect(calls.added.length).toBe(150);
    expect(calls.added.some((a) => a.number === 150)).toBe(true);
    const listCall = calls.request.find((c) => c.route === 'GET /repos/{owner}/{repo}/issues');
    expect(listCall.params.per_page).toBe(100);
  });

  it('registers a readiness success on the default branch head when it is not an open PR head', async () => {
    const { octokit, calls } = buildStub({
      issues: [],
      pulls: [],
      branch: { commit: { sha: 'main-head-sha' } },
    });
    await runPolicy(runOpts(octokit, 'push'));
    const statuses = statusFor(calls, 'main-head-sha');
    expect(statuses).toHaveLength(1);
    expect(statuses[0].state).toBe('success');
    expect(statuses[0].context).toBe(STATUS_CONTEXT);
    expect(statuses[0].description.toLowerCase()).toContain('not a pull request approval');
  });

  it('does not use readiness to approve an open PR whose head equals the default branch head', async () => {
    const { octokit, calls } = buildStub({
      issues: [],
      pulls: [makePull(100, { headSha: 'main-head-sha' })],
      branch: { commit: { sha: 'main-head-sha' } },
    });
    await runPolicy(runOpts(octokit, 'push'));
    const states = statusFor(calls, 'main-head-sha').map((s) => s.state);
    expect(states).toEqual(['pending', 'failure']);
  });

  it('never runs readiness registration on issue or pull request events', async () => {
    const { octokit, calls } = buildStub({ issues: [], pulls: [] });
    await runPolicy(runOpts(octokit, 'issues'));
    expect(calls.request.some((c) => c.route === 'GET /repos/{owner}/{repo}/branches/{branch}')).toBe(false);
  });

  it('keeps untrusted PR text out of logs, descriptions, and code paths', async () => {
    const hostile = 'Refs #1\n<script>process.exit(2)</script> `require("node:child_process")`';
    const { octokit, calls } = buildStub({
      issues: [makeIssue(1, { labels: ['status:approved'] })],
      events: { 1: [approvalEvent(1, OWNER)] },
      pulls: [makePull(110, { body: hostile })],
    });
    const logs = [];
    await runPolicy({ ...runOpts(octokit, 'pull_request_target'), log: (m) => logs.push(String(m)) });
    expect(finalStatus(calls, 'sha-110').state).toBe('success');
    const serialized = JSON.stringify({ logs, statuses: calls.statuses });
    expect(serialized).not.toContain('process.exit');
    expect(serialized).not.toContain('child_process');
  });

  it('refuses to act when the repository owner is not the configured policy owner', async () => {
    const { octokit, calls } = buildStub({ issues: [makeIssue(1)] });
    const opts = runOpts(octokit, 'issues');
    opts.context.repo.owner = 'someone-else';
    await expect(runPolicy(opts)).rejects.toThrow(/policy owner/i);
    expect(calls.request).toEqual([]);
  });
});

// ---------------------------------------------------------------- reference parsing

describe('extractLinkedIssueRefs', () => {
  const repo = { owner: 'efolchmontiel', repo: 'ResTube' };
  it('parses explicit keyword forms case-insensitively', () => {
    expect(extractLinkedIssueRefs('Refs #1, closes #2, FIXES #3, fixed #4, resolved #6, Ref #7', repo))
      .toEqual([1, 2, 3, 4, 6, 7]);
  });

  it('parses canonical same-repo issue URLs but not cross-repo URLs', () => {
    const text = 'https://github.com/efolchmontiel/ResTube/issues/12 https://github.com/other/other/issues/13';
    expect(extractLinkedIssueRefs(text, repo)).toEqual([12]);
  });

  it('ignores bare numbers and code blocks', () => {
    expect(extractLinkedIssueRefs('issue #14 is related', repo)).toEqual([]);
    expect(extractLinkedIssueRefs('```\nCloses #15\n``` and `Fixes #16`', repo)).toEqual([]);
  });

  it('returns sorted unique numbers', () => {
    expect(extractLinkedIssueRefs('Fixes #22\nCloses #20\nFixes #22', repo)).toEqual([20, 22]);
  });
});
