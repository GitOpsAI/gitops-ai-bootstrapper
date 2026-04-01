import { exec, execAsync, execSafe } from "../utils/shell.js";
import { log, withSpinner } from "../utils/log.js";

export async function authenticate(
  pat: string,
  host: string,
): Promise<string> {
  await execAsync(
    `echo "${pat}" | glab auth login --hostname "${host}" --stdin`,
  );
  const username = await execAsync(
    `glab api "user" --hostname "${host}" | jq -r '.username'`,
  );
  log.success(`Authenticated as: ${username}`);
  return username;
}

export async function resolveNamespaceId(
  namespace: string,
  host: string,
): Promise<string> {
  const result = execSafe(
    `glab api --hostname "${host}" "namespaces/${namespace}" 2>/dev/null | jq -r '.id'`,
  );
  if (result.exitCode !== 0 || !result.stdout || result.stdout === "null") {
    throw new Error(
      `Namespace '${namespace}' not found. Check the group or username.`,
    );
  }
  log.success(`Namespace ID: ${result.stdout}`);
  return result.stdout;
}

export interface ProjectInfo {
  id: string;
  httpUrl: string;
  pathWithNamespace: string;
}

export async function getProject(
  namespace: string,
  name: string,
  host: string,
): Promise<ProjectInfo | null> {
  const encoded = `${namespace}/${name}`.replace(/\//g, "%2F");
  const { stdout, exitCode } = execSafe(
    `glab api --hostname "${host}" "projects/${encoded}" 2>/dev/null`,
  );
  if (exitCode !== 0 || !stdout) return null;

  try {
    const data = JSON.parse(stdout);
    if (!data.id) return null;
    return {
      id: String(data.id),
      httpUrl: data.http_url_to_repo,
      pathWithNamespace: data.path_with_namespace,
    };
  } catch {
    return null;
  }
}

export async function createProject(
  name: string,
  namespaceId: string,
  host: string,
): Promise<ProjectInfo> {
  const result = await execAsync(
    [
      "glab api --method POST",
      `--hostname "${host}"`,
      '"projects"',
      `-f "name=${name}"`,
      `-f "path=${name}"`,
      `-f "namespace_id=${namespaceId}"`,
      '-f "visibility=private"',
      '-f "initialize_with_readme=false"',
    ].join(" "),
  );

  const data = JSON.parse(result);
  return {
    id: String(data.id),
    httpUrl: data.http_url_to_repo,
    pathWithNamespace: data.path_with_namespace,
  };
}

export function configureGitCredentials(
  pat: string,
  cwd: string,
): void {
  const { exitCode, stdout } = execSafe(
    "git remote get-url origin 2>/dev/null",
  );
  let host = "gitlab.com";
  if (exitCode === 0 && stdout) {
    const match = stdout.match(/https:\/\/([^/]+)\//);
    if (match) host = match[1];
  }

  exec(
    `git config --local --replace-all credential.helper '!f() { echo "username=oauth2"; echo "password=${pat}"; }; f'`,
    { cwd },
  );
  log.success(`git credentials configured for ${host}`);
}
