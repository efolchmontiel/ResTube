// Policy module for the ResTube public-repository governance gate (S2-S5).
//
// Loaded by .github/workflows/issue-policy.yml from the TRUSTED default-branch
// checkout only. It never reads fork code, never prints secrets, and never
// interpolates user text into commands: every decision is derived from fresh
// GitHub API state for the fixed repository derived from the trusted run
// context. GitHub Actions GITHUB_TOKEN label changes do not retrigger
// workflows, so every invocation fully reconciles the CURRENT open issues and
// the CURRENT open pull request head statuses in the same run.
//
// Guarantees:
// - Ordinary open issues always carry a status label: status:triage is restored
//   whenever it is missing or the approval is unverified, and removed once a
//   verified owner approval exists. Forms prelabel issues; API-created issues
//   are normalized here because GitHub cannot atomically reject them.
// - status:approved may only ever have been applied by the repository owner
//   (account ID checked, not login). The latest "labeled" event for that label
//   decides provenance; forged approvals are removed. A later legitimate owner
//   approval is never lost to a stale queued event because the current API
//   state is always refetched.
// - Pull requests are never closed and never auto-merge. Each open PR gets a
//   commit status (context exactly 'Issue approval gate') on its CURRENT head
//   SHA in the base repository: success only when ALL same-repository linked
//   ordinary issues exist, are open, labeled, and carry a verified owner
//   approval. Anything else fails closed with a closed human-readable message.
// - On push to the default branch / workflow_dispatch, a readiness success is
//   registered on the default branch head SHA only when that SHA is NOT the
//   head of an open PR. Readiness is NOT a PR approval; open PRs are always
//   reconciled normally and still require an approved linked issue.

export const STATUS_CONTEXT = 'Issue approval gate';
export const TRIAGE_LABEL = 'status:triage';
export const APPROVED_LABEL = 'status:approved';
export const OWNER_LOGIN = 'efolchmontiel';
export const OWNER_ID = 22103249;

const READINESS_MESSAGE = 'Default branch readiness check (not a pull request approval).';
const MAX_DESCRIPTION = 140;

function clampDescription(text) {
  if (text.length <= MAX_DESCRIPTION) return text;
  return `${text.slice(0, MAX_DESCRIPTION - 1)}…`;
}

function labelNames(labels) {
  return (labels ?? [])
    .map((label) => (typeof label === 'string' ? label : label?.name))
    .filter((name) => typeof name === 'string');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const KEYWORD_REF_PATTERN = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref|refs)\s+#(\d+)\b/gi;

/**
 * Extract explicit, unambiguous issue references from PR text:
 * keyword forms (Refs/Closes/Fixes/Resolves and variants) plus canonical
 * full same-repository issue URLs. Numbers inside fenced or inline code
 * blocks and cross-repository URLs are never treated as links, and a bare
 * "#N" without a linking keyword is not a reference.
 */
export function extractLinkedIssueRefs(text, { owner, repo }) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
  const refs = new Set();
  for (const match of cleaned.matchAll(KEYWORD_REF_PATTERN)) refs.add(Number(match[1]));
  const urlPattern = new RegExp(
    `https?://github\\.com/${escapeRegExp(owner)}/${escapeRegExp(repo)}/issues/(\\d+)`,
    'gi',
  );
  for (const match of cleaned.matchAll(urlPattern)) refs.add(Number(match[1]));
  return [...refs].sort((a, b) => a - b);
}

function trustedRepository(context) {
  const owner = context?.repo?.owner ?? context?.payload?.repository?.owner?.login;
  const repo = context?.repo?.repo ?? context?.payload?.repository?.name;
  if (!owner || !repo) throw new Error('Unable to determine the trusted repository context; refusing to act.');
  if (owner.toLowerCase() !== OWNER_LOGIN.toLowerCase()) {
    throw new Error(`Repository owner '${owner}' is not the configured policy owner; refusing to act.`);
  }
  return { owner, repo };
}

async function paginate(octokit, route, parameters) {
  return octokit.paginate(route, { per_page: 100, ...parameters });
}

/**
 * Verify approval provenance for an issue by reading its label events through
 * the GitHub API (issues.listEvents). Returns 'verified' only when the LATEST
 * 'labeled' event for status:approved was applied by the owner account ID.
 */
async function verifyApprovalProvenance(octokit, owner, repo, issueNumber, log) {
  const events = await paginate(octokit, 'GET /repos/{owner}/{repo}/issues/{issue_number}/events', {
    owner,
    repo,
    issue_number: issueNumber,
  });
  const approvalEvents = events.filter(
    (event) => event?.event === 'labeled' && event?.label?.name === APPROVED_LABEL,
  );
  const latest = approvalEvents[approvalEvents.length - 1];
  if (!latest) {
    log(`issue #${issueNumber}: status:approved present but no approval event found`);
    return 'missing';
  }
  if (latest.actor?.id === OWNER_ID) return 'verified';
  log(`issue #${issueNumber}: latest status:approved event was applied by a non-owner account`);
  return 'unauthorized';
}

async function addLabels(octokit, owner, repo, issueNumber, labels) {
  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
    owner,
    repo,
    issue_number: issueNumber,
    labels,
  });
}

async function removeLabel(octokit, owner, repo, issueNumber, name) {
  await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', {
    owner,
    repo,
    issue_number: issueNumber,
    name,
  });
}

async function postStatus(octokit, owner, repo, sha, state, description, runUrl) {
  await octokit.request('POST /repos/{owner}/{repo}/statuses/{sha}', {
    owner,
    repo,
    sha,
    state,
    context: STATUS_CONTEXT,
    description: clampDescription(description),
    target_url: runUrl ?? undefined,
  });
}

/**
 * Normalize one open ordinary issue against current label state.
 * The caller supplies freshly listed issue data.
 */
async function reconcileIssue(octokit, owner, repo, issue, log) {
  const labels = labelNames(issue.labels);
  const hasTriage = labels.includes(TRIAGE_LABEL);
  const hasApproved = labels.includes(APPROVED_LABEL);

  if (hasApproved) {
    const provenance = await verifyApprovalProvenance(octokit, owner, repo, issue.number, log);
    if (provenance === 'verified') {
      if (hasTriage) {
        await removeLabel(octokit, owner, repo, issue.number, TRIAGE_LABEL);
        log(`issue #${issue.number}: verified owner approval, removed ${TRIAGE_LABEL}`);
      }
      return;
    }
    // Forged or unverifiable approval: remove it and restore triage.
    await removeLabel(octokit, owner, repo, issue.number, APPROVED_LABEL);
    if (!hasTriage) await addLabels(octokit, owner, repo, issue.number, [TRIAGE_LABEL]);
    log(`issue #${issue.number}: removed unverified ${APPROVED_LABEL}, restored ${TRIAGE_LABEL}`);
    return;
  }

  if (!hasTriage) {
    await addLabels(octokit, owner, repo, issue.number, [TRIAGE_LABEL]);
    log(`issue #${issue.number}: restored ${TRIAGE_LABEL}`);
  }
}

/**
 * Evaluate one eligibility requirement for a linked issue number.
 * Returns null when eligible, or a short human-readable rejection reason.
 * Non-404 API errors are rethrown so the run fails closed instead of
 * guessing eligibility from partial data.
 */
async function checkLinkedIssue(octokit, owner, repo, issueNumber, log) {
  let issue;
  try {
    ({ data: issue } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner,
      repo,
      issue_number: issueNumber,
    }));
  } catch (error) {
    if (error?.status === 404) return `#${issueNumber} does not exist in this repository`;
    throw error;
  }
  if (issue.pull_request) return `#${issueNumber} is a pull request, not an issue`;
  if (issue.state !== 'open') return `#${issueNumber} is not open`;
  const labels = labelNames(issue.labels);
  if (labels.length === 0) return `#${issueNumber} has no labels`;
  if (!labels.includes(APPROVED_LABEL)) return `#${issueNumber} is not approved`;
  const provenance = await verifyApprovalProvenance(octokit, owner, repo, issueNumber, log);
  if (provenance !== 'verified') {
    // Forged approval on a linked issue: strip it and restore triage in the
    // same run so the forged state does not survive this invocation.
    await removeLabel(octokit, owner, repo, issueNumber, APPROVED_LABEL);
    if (!labels.includes(TRIAGE_LABEL)) {
      await addLabels(octokit, owner, repo, issueNumber, [TRIAGE_LABEL]);
    }
    return `#${issueNumber} approval was not granted by the repository owner`;
  }
  return null;
}

/**
 * Reconcile one open pull request: post a pending status on the fresh head
 * SHA, validate ALL linked issues against fresh API state, then post the
 * final success/failure status. The PR is never closed and no approval is
 * ever granted here.
 */
async function reconcilePullRequest(octokit, owner, repo, pullRequest, runUrl, log) {
  const { data: current } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
    owner,
    repo,
    pull_number: pullRequest.number,
  });
  if (current.state !== 'open' || !current.head?.sha) return;
  const headSha = current.head.sha;
  await postStatus(octokit, owner, repo, headSha, 'pending', 'Checking linked issue approval…', runUrl);
  const refs = extractLinkedIssueRefs(`${current.title ?? ''}\n${current.body ?? ''}`, { owner, repo });
  if (refs.length === 0) {
    await postStatus(octokit, owner, repo, headSha, 'failure',
      "Merge blocked: no linked issue. Reference an owner-approved issue with 'Refs #N'.", runUrl);
    log(`pull request #${current.number}: failure (no linked issue)`);
    return;
  }
  const reasons = [];
  for (const issueNumber of refs) {
    const reason = await checkLinkedIssue(octokit, owner, repo, issueNumber, log);
    if (reason) reasons.push(reason);
  }
  if (reasons.length > 0) {
    await postStatus(octokit, owner, repo, headSha, 'failure',
      `Merge blocked: ${reasons.join('; ')}.`, runUrl);
    log(`pull request #${current.number}: failure (${reasons.length} ineligible reference(s))`);
    return;
  }
  await postStatus(octokit, owner, repo, headSha, 'success',
    `Linked issue(s) ${refs.map((n) => `#${n}`).join(', ')} approved by the repository owner.`, runUrl);
  log(`pull request #${current.number}: success (approved linked issue(s) ${refs.join(', ')})`);
}

/**
 * Readiness bootstrap for push-to-default-branch / workflow_dispatch runs:
 * register an 'Issue approval gate' success on the default branch head SHA
 * only when that SHA is not the head of an open PR. This readiness status is
 * NOT a PR approval; open pull requests are reconciled normally above and
 * still require an owner-approved linked issue.
 */
async function registerReadiness(octokit, owner, repo, defaultBranch, openPulls, runUrl) {
  const { data: branch } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
    owner,
    repo,
    branch: defaultBranch,
  });
  const headSha = branch?.commit?.sha;
  if (!headSha) return;
  const isPullRequestHead = openPulls.some((pr) => pr?.head?.sha === headSha);
  if (isPullRequestHead) return;
  await postStatus(octokit, owner, repo, headSha, 'success', READINESS_MESSAGE, runUrl);
}

/**
 * Public entry point used by the workflow (actions/github-script) and tests.
 * Every invocation fully reconciles CURRENT state, so it is safe for GitHub
 * to replace queued runs behind the repository-wide concurrency group
 * (cancel-in-progress: false, and even a cancelled older run loses nothing
 * because a newer run re-reads the same fresh state).
 */
export async function runPolicy({ octokit, context, config = {}, log = () => {} }) {
  const runUrl = config.runUrl ?? null;
  const { owner, repo } = trustedRepository(context);
  const defaultBranch = context?.payload?.repository?.default_branch ?? 'main';
  const errors = [];

  // 1. Reconcile every open ordinary issue against fresh label state.
  const openIssues = await paginate(octokit, 'GET /repos/{owner}/{repo}/issues', { owner, repo, state: 'open' });
  for (const issue of openIssues) {
    if (issue.pull_request) continue; // pull requests are reconciled below through the PR gate
    try {
      await reconcileIssue(octokit, owner, repo, issue, log);
    } catch (error) {
      errors.push(`issue #${issue.number}: ${error?.status ?? 'error'}`);
      log(`issue #${issue.number}: reconciliation failed with an API error (${error?.status ?? 'unknown'})`);
    }
  }

  // 2. Reconcile every open pull request head status against fresh PR/issue state.
  const openPulls = await paginate(octokit, 'GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open' });
  for (const pullRequest of openPulls) {
    try {
      await reconcilePullRequest(octokit, owner, repo, pullRequest, runUrl, log);
    } catch (error) {
      errors.push(`pull request #${pullRequest.number}: ${error?.status ?? 'error'}`);
      log(`pull request #${pullRequest.number}: reconciliation failed with an API error (${error?.status ?? 'unknown'})`);
      const headSha = pullRequest?.head?.sha;
      if (headSha) {
        // Fail closed: never leave a PR claiming success after an API error.
        try {
          await postStatus(octokit, owner, repo, headSha, 'failure',
            'Merge blocked: validation error, re-run the check.', runUrl);
        } catch {
          // The workflow run itself will fail below; nothing claims success.
        }
      }
    }
  }

  // 3. Readiness bootstrap (push to default branch / workflow_dispatch only).
  const eventName = context?.eventName;
  if (eventName === 'push' || eventName === 'workflow_dispatch') {
    try {
      await registerReadiness(octokit, owner, repo, defaultBranch, openPulls, runUrl);
    } catch (error) {
      errors.push(`readiness: ${error?.status ?? 'error'}`);
      log(`readiness registration failed with an API error (${error?.status ?? 'unknown'})`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Issue approval gate reconciliation hit ${errors.length} API error(s) and must not be treated as successful. ` +
      `Affected units (first only, numbers only): ${errors[0]}`,
    );
  }
}
