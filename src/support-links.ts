/** Extension point for installation-specific URL normalization.
 * The portfolio distribution does not inherit redirects from a real service.
 */
export function normalizeSupportLinks(text: string): string {
  return String(text || '');
}
