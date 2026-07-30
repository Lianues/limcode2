export type SignatureProviderId = string;
export type SignatureRepresentation = 'string' | 'object';
export type SignatureOutputMode = 'auto' | 'string' | 'object' | 'preserve';

export interface SignatureNormalizationOptions {
  /** 无前缀字符串时，用哪个格式/渠道来推断签名类型 */
  formatHint?: SignatureProviderId;
}

export interface SignatureSerializationOptions {
  mode?: 'string' | 'object';
  /** string 模式下优先取哪个 provider 的签名 */
  preferProvider?: SignatureProviderId;
  /** string 模式下无法唯一选出签名时，是否回退为对象模式，默认 true */
  fallbackToObject?: boolean;
}
