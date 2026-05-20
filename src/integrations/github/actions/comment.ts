import { GitHubApiClient } from '../api.js';
import type { ActionHandler } from '../../../core/types.js';
import { resolveRepoTarget, requireToken } from './_target.js';

/**
 * "github-comment" action.
 *
 * Posts a comment on a PR or issue. Resolution of owner/repo/number
 * is delegated to the shared `_target.ts` helper so this handler
 * accepts the same input shapes as every other GitHub action — most
 * importantly an `"owner/name"` string in `params.repo` (which is what
 * `data.pr-fields.repo` outputs and what the visual editor's "Repository"
 * port label implies). The previous bespoke resolver here read
 * `params.repo` as the bare name and treated `Tjemmmic/meikai` as a
 * literal path segment, producing a `POST /repos/<owner>/Tjemmmic/meikai/...`
 * URL that GitHub 404s.
 */
export const githubCommentAction: ActionHandler = async (params, context) => {
    const token = requireToken(params, context, 'github-comment');
    const target = resolveRepoTarget(params, context, 'github-comment');

    const body = params.body as string;
    if (!body) {
        throw new Error('github-comment requires a "body" param.');
    }

    const client = new GitHubApiClient(token);

    context.logger.info(
        { owner: target.owner, repo: target.repo, issueNumber: target.number },
        'Posting comment to GitHub',
    );

    const result = await client.createComment(target.owner, target.repo, target.number, body);

    context.logger.info(
        { owner: target.owner, repo: target.repo, issueNumber: target.number, commentId: result.id },
        'Comment posted',
    );

    // Emit BOTH the canonical port names the github.comment node
    // declares (`commentId`, `url`) AND the snake_case keys earlier
    // code used. The node-port declarations in core/nodes/builtins.ts
    // are the contract a downstream `{{nodes.post.commentId}}` wire
    // reads; the snake_case keys stay for back-compat with any legacy
    // template that referenced them.
    return {
        commentId: result.id,
        url: result.html_url,
        comment_id: result.id,
        html_url: result.html_url,
    };
};
