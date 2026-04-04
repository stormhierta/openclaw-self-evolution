const { SecretDetector } = await import('./src/dataset/external-importers/secret-detector.js');

const testKey = 'sk-ant-api03-test123456789';
const testText = 'Hello, use this key: sk-ant-api03-test123456789 for the API call.';

console.log('containsSecret(key):', SecretDetector.containsSecret(testKey));
console.log('containsSecret(text):', SecretDetector.containsSecret(testText));
console.log('redact(text):', SecretDetector.redact(testText));
console.log('redact preserves surrounding:', SecretDetector.redact('prefix sk-ant-api03-test123456789 suffix'));
console.log('empty string containsSecret:', SecretDetector.containsSecret(''));
console.log('empty string redact:', SecretDetector.redact(''));
