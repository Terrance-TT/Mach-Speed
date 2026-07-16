/**
 * TEMPLATE — Copy this to create a new specialist.
 * Rename to your-check-name.js, fill in the blanks, test with test-harness.js.
 */

export const checkId = 'your-check-id';       // kebab-case, unique
export const name = 'Your Check Name';        // human-readable
export const appliesTo = ['all'];             // or ['deployable','server'] etc

export async function check(context) {
  const { tree, files, packageJson, repoType } = context;

  try {
    // YOUR SCANNING LOGIC HERE
    // tree = array of file paths
    // files.get(path) = async, returns file content string or null
    // files.has(path) = boolean
    // packageJson = parsed package.json or null
    // repoType = 'empty'|'library'|'deployable'|'server'|'framework'|'tool'|'unknown'

    return {
      checkId,
      status: 'check-it',
      confidence: 'low',
      message: 'Specialist not yet implemented — template placeholder',
      findings: [],
    };

  } catch (err) {
    return { checkId, status: 'check-it', confidence: 'low', message: `Error: ${err.message}`, findings: [] };
  }
}
