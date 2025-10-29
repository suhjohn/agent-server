declare module "jsonwebtoken" {
  export interface JwtPayload {
    [key: string]: unknown;
  }

  export interface SignOptions {
    algorithm?: string;
    expiresIn?: string | number;
    audience?: string | string[];
    issuer?: string;
    subject?: string;
    jwtid?: string;
  }

  export interface VerifyOptions {
    audience?: string | string[];
    issuer?: string | string[];
  }

  export interface JwtModule {
    sign(
      payload: string | Buffer | object,
      secretOrPrivateKey: string | Buffer,
      options?: SignOptions
    ): string;
    verify(
      token: string,
      secretOrPublicKey: string | Buffer,
      options?: VerifyOptions
    ): string | JwtPayload;
  }

  const jwt: JwtModule;
  export default jwt;
  export { JwtPayload, SignOptions, VerifyOptions };

  export function sign(
    payload: string | Buffer | object,
    secretOrPrivateKey: string | Buffer,
    options?: SignOptions
  ): string;

  export function verify(
    token: string,
    secretOrPublicKey: string | Buffer,
    options?: VerifyOptions
  ): string | JwtPayload;
}
