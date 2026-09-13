const fs = require('fs');
const path = require('path');

const DEFAULT_RESUME = path.join(__dirname, '..', '..', 'data', 'docs', 'resume.cv');

// Canonical labels and common spellings. Keeping this deterministic makes
// matching explainable and avoids sending a private resume to a third party.
const SKILL_ALIASES = {
  aws: ['aws', 'amazon web services'],
  azure: ['azure', 'microsoft cloud'],
  gcp: ['gcp', 'google cloud'],
  kubernetes: ['kubernetes', 'k8s'],
  docker: ['docker', 'containers'],
  terraform: ['terraform', 'infrastructure as code', 'iac'],
  ansible: ['ansible'],
  jenkins: ['jenkins'],
  'github actions': ['github actions'],
  'ci/cd': ['ci/cd', 'continuous integration', 'continuous delivery'],
  devsecops: ['devsecops'],
  devops: ['devops'],
  cybersecurity: ['cybersecurity', 'cyber security', 'information security'],
  iam: ['identity and access management', 'iam'],
  'incident response': ['incident response'],
  'risk management': ['risk management'],
  compliance: ['compliance', 'governance risk and compliance', 'grc'],
  nist: ['nist'],
  'zero trust': ['zero trust'],
  'application security': ['application security', 'appsec'],
  'cloud security': ['cloud security'],
  'security architecture': ['security architecture', 'security architect'],
  'vulnerability management': ['vulnerability management'],
  'threat modeling': ['threat modeling'],
  python: ['python'],
  javascript: ['javascript'],
  typescript: ['typescript'],
  go: ['golang', 'go language'],
  bash: ['bash', 'shell scripting'],
  powershell: ['powershell'],
  linux: ['linux'],
  windows: ['windows'],
  splunk: ['splunk'],
  datadog: ['datadog'],
  sentinel: ['microsoft sentinel', 'azure sentinel'],
  vault: ['hashicorp vault', 'vault'],
  prometheus: ['prometheus'],
  grafana: ['grafana'],
  snyk: ['snyk'],
  trivy: ['trivy'],
  sonarqube: ['sonarqube'],
  paloalto: ['palo alto'],
  crowdstrike: ['crowdstrike'],
  cissp: ['cissp'],
  ccsp: ['ccsp'],
  cisa: ['cisa'],
  securityplus: ['security+', 'security plus']
};

function countOccurrences(text, aliases) {
  const lower = text.toLowerCase();
  let count = 0;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = lower.match(new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'g'));
    count += matches ? matches.length : 0;
  }
  return count;
}

function extractProfile(text, sourcePath = null) {
  const skills = [];
  for (const [name, aliases] of Object.entries(SKILL_ALIASES)) {
    const count = countOccurrences(text, aliases);
    if (count) skills.push({ name, count });
  }
  skills.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const years = [...text.matchAll(/\b(\d{1,2})\+?\s+years?\b/gi)]
    .map(match => Number(match[1])).filter(value => value <= 50);
  return {
    source_path: sourcePath,
    generated_at: new Date().toISOString(),
    skills,
    keywords: skills.map(skill => skill.name),
    max_claimed_years: years.length ? Math.max(...years) : null
  };
}

function skillsInText(text) {
  const found = [];
  for (const [name, aliases] of Object.entries(SKILL_ALIASES)) {
    if (countOccurrences(String(text || ''), aliases) > 0) found.push(name);
  }
  return found;
}

function searchTerms(profile, criteria, limit = 8) {
  const configured = criteria?.search?.terms || [];
  const primary = configured.length
    ? configured
    : (criteria?.titles?.must_match_any || []).slice(0, 5);
  const usefulSkills = (profile?.keywords || []).filter(skill =>
    ['aws', 'azure', 'gcp', 'kubernetes', 'terraform', 'iam', 'devops', 'devsecops'].includes(skill)
  );
  const assisted = usefulSkills.slice(0, 3).map(skill => `${skill} security`);
  return [...new Set([...primary, ...assisted])].slice(0, limit);
}

function loadProfile(resumePath = process.env.RESUME_PATH || DEFAULT_RESUME) {
  if (!fs.existsSync(resumePath)) return null;
  return extractProfile(fs.readFileSync(resumePath, 'utf8'), resumePath);
}

function scoreAgainstProfile(job, profile) {
  if (!profile) return { score: 0, reasons: [], matchedSkills: [], missingSkills: [] };
  const title = String(job.title || '');
  const body = `${job.description || ''} ${job.company || ''}`;
  const reasons = [];
  const matchedSkills = [];
  let score = 0;

  for (const skill of profile.skills) {
    const aliases = SKILL_ALIASES[skill.name] || [skill.name];
    const inTitle = countOccurrences(title, aliases) > 0;
    const inBody = countOccurrences(body, aliases) > 0;
    if (!inTitle && !inBody) continue;
    score += inTitle ? 3 : 1;
    matchedSkills.push(skill.name);
    reasons.push(`resume_skill:${skill.name}${inTitle ? ':title' : ''}`);
  }
  const resumeSkills = new Set(profile.skills.map(skill => skill.name));
  const jobSkills = skillsInText(`${title} ${body}`);
  const missingSkills = jobSkills.filter(skill => !resumeSkills.has(skill));
  return { score: Math.min(score, 30), reasons, matchedSkills, missingSkills };
}

function writeProfile(outputPath, resumePath) {
  const profile = loadProfile(resumePath);
  if (!profile) throw new Error(`resume not found: ${resumePath || process.env.RESUME_PATH || DEFAULT_RESUME}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(profile, null, 2) + '\n');
  return profile;
}

module.exports = {
  DEFAULT_RESUME, SKILL_ALIASES, extractProfile, loadProfile,
  skillsInText, searchTerms, scoreAgainstProfile, writeProfile
};
