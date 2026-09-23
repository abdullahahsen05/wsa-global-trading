export function normalizeBrokerLogin(value: string): string {
  return value.replace(/\s+/g, "");
}
