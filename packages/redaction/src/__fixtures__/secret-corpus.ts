/**
 * SYNTHETIC secret corpus. Every value is generated from a fixed-seed PRNG at test time, so no real or realistic
 * credential is stored in the repository. Formats imitate real token shapes only so the detectors can be exercised.
 */

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_NUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B64 = ALNUM + "+/";
const URLSAFE = ALNUM + "-_";
const HEX = "0123456789abcdef";

export interface SecretCase {
  name: string;
  /** Text containing the secret(s). */
  text: string;
  /** Values that must not survive redaction. */
  secrets: string[];
  /** Expected detector for the first secret (informational; any detector is accepted for coverage). */
  expected: string;
  knownSecrets?: string[];
  registryValues?: string[];
}

export function buildSecretCorpus(seed = 20261017): SecretCase[] {
  const rnd = prng(seed);
  const pick = (alphabet: string, n: number) => Array.from({ length: n }, () => alphabet[Math.floor(rnd() * alphabet.length)]!).join("");
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");

  const pemBody = Array.from({ length: 6 }, () => pick(B64, 64)).join("\n");
  const sshBody = Array.from({ length: 4 }, () => pick(B64, 70)).join("\\n");
  const jwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "kw-synthetic-user", iat: 1760000000 })}.${pick(URLSAFE, 43)}`;
  const aws = `AKIA${pick(UPPER_NUM, 16)}`;
  const awsSecret = pick(B64, 40);
  const ghp = `ghp_${pick(ALNUM, 36)}`;
  const ghpat = `github_pat_${pick(ALNUM, 22)}_${pick(ALNUM, 59)}`;
  const glpat = `glpat-${pick(URLSAFE, 20)}`;
  const antApi = `sk-ant-api03-${pick(URLSAFE, 93)}AA`;
  const antOat = `sk-ant-oat01-${pick(URLSAFE, 95)}`;
  const oaiProj = `sk-proj-${pick(URLSAFE, 120)}`;
  const aiand = `sk-${pick(ALNUM, 48)}`;
  const xoxb = `xoxb-${pick("0123456789", 12)}-${pick("0123456789", 13)}-${pick(ALNUM, 24)}`;
  const slackHook = `T${pick(UPPER_NUM, 8)}/B${pick(UPPER_NUM, 10)}/${pick(ALNUM, 24)}`;
  const pgPass = pick(ALNUM, 18);
  const gitPass = pick(ALNUM, 30);
  const envPass = pick(ALNUM, 16);
  const envStripe = `${pick(ALNUM, 32)}`;
  const envTok = pick(URLSAFE, 28);
  const exportTok = pick(ALNUM, 26);
  const clientSecret = pick(URLSAFE, 34);
  const yamlPass = `S3cr${pick(ALNUM, 10)}`;
  const bearer = pick(URLSAFE, 40);
  const xApiKey = pick(ALNUM, 32);
  const loose = pick(ALNUM, 40);
  const looseHex = pick(HEX, 48);
  const inline = pick(ALNUM, 20);
  const known = `kw-run-key-${pick(ALNUM, 12)}`;
  const registryValue = `kw-synthetic-value-${pick(ALNUM, 8)}`;
  const curlPass = pick(ALNUM, 14);

  return [
    { name: "dotenv synthetic", text: "KW_SYNTHETIC_SECRET=kw-test-0000", secrets: ["kw-test-0000"], expected: "synthetic_secret" },
    { name: "hook stdout json", text: '{"tool_response":{"stdout":"KW_SYNTHETIC_SECRET=kw-test-0000","stderr":""}}', secrets: ["kw-test-0000"], expected: "synthetic_secret" },
    { name: "bare synthetic value", text: "diff: -kw-test-0000 +kw-test-0001", secrets: ["kw-test-0000", "kw-test-0001"], expected: "synthetic_secret" },
    { name: "synthetic name, other value", text: 'KW_SYNTHETIC_SECRET="hunter2-local"', secrets: ["hunter2-local"], expected: "synthetic_secret" },
    {
      name: "registry value base64",
      text: `echo ${Buffer.from(registryValue).toString("base64")} | base64 -d`,
      secrets: [Buffer.from(registryValue).toString("base64"), registryValue],
      expected: "synthetic_secret",
      registryValues: [registryValue],
    },
    { name: "zero-width split synthetic", text: "value kw-te​st-0000 leaked", secrets: ["kw-test-0000", "kw-te​st-0000"], expected: "synthetic_secret" },
    { name: "pem rsa", text: `-----BEGIN RSA PRIVATE KEY-----\n${pemBody}\n-----END RSA PRIVATE KEY-----`, secrets: pemBody.split("\n"), expected: "private_key" },
    { name: "pem openssh json-escaped", text: `{"content":"-----BEGIN OPENSSH PRIVATE KEY-----\\n${sshBody}\\n-----END OPENSSH PRIVATE KEY-----\\n"}`, secrets: sshBody.split("\\n"), expected: "private_key" },
    { name: "pem unterminated", text: `-----BEGIN PRIVATE KEY-----\n${pemBody.slice(0, 130)}`, secrets: [pemBody.slice(0, 64)], expected: "private_key" },
    { name: "jwt", text: `Cookie session=${jwt}; Path=/`, secrets: [jwt], expected: "jwt" },
    { name: "aws access key", text: `aws configure set aws_access_key_id ${aws}`, secrets: [aws], expected: "aws_access_key" },
    { name: "aws secret key", text: `aws_secret_access_key = ${awsSecret}`, secrets: [awsSecret], expected: "aws_secret_key" },
    { name: "github classic", text: `git clone https://x-access-token:${ghp}@github.com/acme/app.git`, secrets: [ghp], expected: "github_token" },
    { name: "github fine-grained", text: `GH_TOKEN ${ghpat}`, secrets: [ghpat], expected: "github_token" },
    { name: "gitlab pat", text: `curl --header "PRIVATE-TOKEN: ${glpat}" https://gitlab.example/api/v4/projects`, secrets: [glpat], expected: "gitlab_token" },
    { name: "anthropic api key", text: `ANTHROPIC_API_KEY=${antApi}`, secrets: [antApi], expected: "anthropic_key" },
    { name: "anthropic oauth token", text: `token file contains ${antOat}`, secrets: [antOat], expected: "anthropic_key" },
    { name: "openai project key", text: `client = OpenAI(api_key="${oaiProj}")`, secrets: [oaiProj], expected: "openai_style_key" },
    { name: "ai& style sk key", text: `Authorization: Bearer ${aiand}`, secrets: [aiand], expected: "openai_style_key" },
    { name: "slack bot token", text: `SLACK=${xoxb}`, secrets: [xoxb], expected: "slack_token" },
    { name: "slack webhook", text: `POST https://hooks.slack.com/services/${slackHook}`, secrets: [slackHook], expected: "slack_token" },
    { name: "postgres url creds", text: `DATABASE_URL=postgres://app:${pgPass}@db.internal:5432/app`, secrets: [pgPass], expected: "url_credentials" },
    { name: "https url creds", text: `remote: https://deploy:${gitPass}@git.example.com/repo.git`, secrets: [gitPass], expected: "url_credentials" },
    {
      name: "dotenv multi-line",
      text: `# local env\nDATABASE_PASSWORD=${envPass}\nSTRIPE_SECRET_KEY=${envStripe}\nAPI_TOKEN="${envTok}"\nAPP_PORT=8080\nDEBUG=true`,
      secrets: [envPass, envStripe, envTok],
      expected: "env_secret_value",
    },
    { name: "export token", text: `export DEPLOY_TOKEN=${exportTok}`, secrets: [exportTok], expected: "env_secret_value" },
    { name: "inline env in command", text: `SERVICE_API_KEY=${inline} ./run.sh --verbose`, secrets: [inline], expected: "env_secret_value" },
    { name: "json client secret", text: `{"client_id":"web-app","client_secret":"${clientSecret}","redirect":"/cb"}`, secrets: [clientSecret], expected: "env_secret_value" },
    { name: "yaml password", text: `database:\n  user: app\n  password: ${yamlPass}\n  host: db`, secrets: [yamlPass], expected: "env_secret_value" },
    { name: "bearer header", text: `-H 'Authorization: Bearer ${bearer}'`, secrets: [bearer], expected: "auth_header" },
    { name: "x-api-key header", text: `curl -H "x-api-key: ${xApiKey}" https://api.example.com`, secrets: [xApiKey], expected: "auth_header" },
    { name: "curl basic user", text: `curl -u admin:${curlPass} https://ci.example/api`, secrets: [curlPass], expected: "auth_header" },
    { name: "loose high-entropy token", text: `rotated credential, new value ${loose} (store it)`, secrets: [loose], expected: "high_entropy" },
    { name: "loose hex secret", text: `signing secret: ${looseHex}`, secrets: [looseHex], expected: "high_entropy" },
    { name: "known secret (exact value)", text: `GET /cb?k=${known}&x=1`, secrets: [known], expected: "known_secret", knownSecrets: [known] },
    { name: "known secret base64", text: `blob=${Buffer.from(known).toString("base64")}`, secrets: [Buffer.from(known).toString("base64")], expected: "known_secret", knownSecrets: [known] },
  ];
}
