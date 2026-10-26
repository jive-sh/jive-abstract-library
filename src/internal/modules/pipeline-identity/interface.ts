import type { EffectGen } from "effective-modules";

/**
 * Who this pipeline job is, as an OIDC ID token its CI provider signs. Jive's server and npm both accept
 * these tokens in place of a stored secret, so a deploy holding none can still prove what it is.
 */
export interface IPipelineIdentity {
  /**
   * A fresh ID token for `audience`, the service it will be shown to. Tokens are short-lived, so take a new
   * one for every request rather than keeping one. Fails outside a job allowed to request one.
   */
  idToken(audience: string): EffectGen<string, string>;
}
