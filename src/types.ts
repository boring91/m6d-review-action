export type RestMethod = (...args: any[]) => Promise<any>;

export type GitHub = {
  rest: Record<string, Record<string, RestMethod>>;
  paginate<T = any>(
    endpoint: RestMethod,
    parameters: Record<string, unknown>,
  ): Promise<T[]>;
  graphql<T = any>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T>;
};

export type Core = {
  info(message: string): void;
  notice(message: string): void;
  warning(message: string): void;
  setFailed(message: string): void;
  setOutput(name: string, value: unknown): void;
};

export type PullRequest = {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  draft: boolean;
  user: { login: string };
  base: { ref: string; sha: string };
  head: {
    ref: string;
    sha: string;
    repo: { full_name: string } | null;
  };
};

export type Comment = {
  id: number;
  body?: string | null;
  user: { login: string; type?: string };
  author_association?: string;
  in_reply_to_id?: number;
  path?: string | null;
  line?: number | null;
  original_line?: number | null;
  diff_hunk?: string | null;
  created_at?: string;
};

export type Context = {
  repo: { owner: string; repo: string };
  payload: {
    pull_request?: PullRequest;
    issue?: {
      number: number;
      state: string;
      pull_request?: unknown;
    };
    comment?: Comment;
    repository?: { default_branch: string };
  };
};

export type HandlerOptions = {
  github: GitHub;
  context: Context;
  core: Core;
};
