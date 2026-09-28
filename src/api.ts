import { config } from "./config.js";
import { session } from "./session.js";

export class MidasApiError extends Error {}

const SESSION_EXPIRED =
  "Midas session has expired and could not be renewed. Approve the login " +
  "notification in the Midas mobile app, then retry.";

/**
 * Issue a GraphQL request from inside the authenticated page so that session
 * cookies are attached by the browser. The request is built as a string rather
 * than a callback because the page has no access to this module's scope.
 */
export async function gql<T = any>(
  operationName: string,
  query: string,
  variables: Record<string, unknown> = {},
  /** Overrides the routing header when the document's first selection is an alias. */
  rootFieldOverride?: string
): Promise<T> {
  const body = JSON.stringify({ operationName, query, variables });

  // The gateway routes on the root field name, which is normally the first selection
  // in the document — but an alias there would route nowhere, hence the override.
  const rootField =
    rootFieldOverride ?? query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? operationName;

  const request = async (): Promise<{ status: number; text: string }> => {
    await session.ensureFresh();
    const page = await session.getPage();
    const rid = await session.getRid();
    return (await page.evaluate(
    `(async () => {
       const res = await fetch(${JSON.stringify(config.graphqlUrl)}, {
         method: "POST",
         credentials: "include",
         headers: {
           "content-type": "application/json",
           "accept": "application/graphql-response+json,application/json;q=0.9",
           "accept-language": "TR",
           "midas-app-id": "midas_web",
           "x-apollo-operation-name": ${JSON.stringify(rootField)},
           "x-client-version": ${JSON.stringify(config.clientVersion)},
           "x-midas-rid": ${JSON.stringify(rid)},
         },
         body: ${JSON.stringify(body)},
       });
       return { status: res.status, text: await res.text() };
     })()`
    )) as { status: number; text: string };
  };

  let result: { status: number; text: string };
  try {
    result = await request();
  } catch (error) {
    if (!session.isLoggedOut()) throw error;
    try {
      await session.recoverAuth();
      // An interrupted mutation may have reached Midas. Only replay reads.
      if (!/^\s*query\b/i.test(query)) throw new MidasApiError("Session restored; retry the mutation after checking its status.");
      result = await request();
    } catch (recoveryError) {
      if (recoveryError instanceof MidasApiError) throw recoveryError;
      throw new MidasApiError(`${SESSION_EXPIRED} (${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)})`);
    }
  }

  if (result.status === 401 || result.status === 403) {
    try {
      await session.recoverAuth();
      result = await request();
    } catch (error) {
      throw new MidasApiError(`${SESSION_EXPIRED} (${error instanceof Error ? error.message : String(error)})`);
    }
    if (result.status === 401 || result.status === 403) {
      throw new MidasApiError(`Midas rejected the request with HTTP ${result.status} after session renewal`);
    }
  }

  let parsed: { data?: T; errors?: { message: string }[] };
  try {
    parsed = JSON.parse(result.text);
  } catch {
    throw new MidasApiError(`Unexpected response from Midas (HTTP ${result.status}): ${result.text.slice(0, 300)}`);
  }

  if (parsed.errors?.length) {
    throw new MidasApiError(parsed.errors.map((e) => e.message).join("; "));
  }
  if (!parsed.data) throw new MidasApiError("Midas returned no data");
  return parsed.data;
}
