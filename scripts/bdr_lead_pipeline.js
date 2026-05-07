#!/usr/bin/env node
// bdr_lead_pipeline.js — End-to-end BDR lead cleanup pipeline.
//
// Runs seven steps in order:
//   1. Lifecycle Stage Correction — contacts marked "opportunity" with no
//      open deal (by company association or email domain) are reset to "lead".
//   2. Customer Deduplication — contacts belonging to customer companies
//      (by association, company name, or email domain) are set to lifecycle
//      stage "customer".
//   3. Contact Type Cleanup — non-prospect contacts (partners, investors,
//      vendors, employees, customers) tagged with "Disqualified" lead status;
//      remaining blank contact_type contacts tagged "Prospective Customer".
//   4. ICP Cleanup — non-ICP contacts tagged with "Disqualified" lead status;
//      ICP contacts re-qualified by activity.
//   5. LinkedIn Enrichment — remaining ICP contacts enriched with LinkedIn
//      URLs via PDL-first → Apollo fallback waterfall.
//   6. Primary Industry Enrichment — classify contacts by company homepage
//      into enterprise_smb_industry + industry text + company industry enum.
//   7. Blank Lead Status Cleanup — contacts with blank hs_lead_status are
//      classified by activity into "Working" or "New".
//
// Usage:
//   HUBSPOT_ACCESS_TOKEN="..." node scripts/bdr_lead_pipeline.js \
//     --owner-id 89305622 \
//     [--dry-run] \
//     [--skip-apollo] \
//     [--skip-pdl] \
//     [--skip-lifecycle] \
//     [--skip-customer-dedup] \
//     [--skip-contact-type] \
//     [--skip-icp] \
//     [--skip-enrichment] \
//     [--skip-industry] \
//     [--skip-lead-status] \
//     [--max-enrich 50] \
//     [--log-file ./pipeline.csv]
//
// Env vars:
//   HUBSPOT_ACCESS_TOKEN  — HubSpot private app token (required)
//   PDL_API               — People Data Labs API key (for enrichment)
//   APOLLO_BULK_MATCH     — Apollo API key (for enrichment fallback)
//   APOLLO_WEBHOOK_URL    — Public URL for phone webhook receiver (optional;
//                           e.g. https://<id>.ngrok-free.app/apollo-webhook)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// ICP config
// ---------------------------------------------------------------------------

const ICP_SINGLE_TOKENS = ["cfo", "ceo", "controller"];

const ICP_COMPOUND_TOKENS = [
  ["head", "finance"],
  ["head", "financial"],
  ["vp", "finance"],
  ["vp", "financial"],
  ["vice", "finance"],
  ["vice", "financial"],
  ["chief", "financial"],
  ["chief", "executive"],
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE = "https://api.hubapi.com";
const BATCH_SIZE = 100;
const SEARCH_LIMIT = 100;
const MAX_RETRIES = 5;
const INITIAL_BACKOFF_MS = 1000;

// Active Pipeline — open stages only (not Won/Closed Lost)
const ACTIVE_PIPELINE_ID = "105321581";
const CLOSED_STAGES = ["1166230571", "190380587"]; // Won, Closed/Lost

const TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;
const PDL_KEY = process.env.PDL_API || "";
const APOLLO_KEY = process.env.APOLLO_BULK_MATCH || "";

// Free email providers to ignore when extracting company domains
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
  "icloud.com", "me.com", "live.com", "msn.com", "protonmail.com", "mail.com",
]);

// ---------------------------------------------------------------------------
// Industry classification config (ported from enrich_industry.py)
// ---------------------------------------------------------------------------

// Primary industry keyword rules (order matters — first match wins)
const CLASSIFY_RULES = [
  [/\b(hospital|medical|health\s*care|clinic|patient|doctor|physician|dental|dentist|orthodont|chiropractic|optometr|ophthalm|dermatolog|cardio|oncolog|radiology|nursing|nurse|pharma|rx\b|drug\s*develop|therapeut|biotech|biopharm|clinical\s*trial|life\s*science|med\s*device|medical\s*device|telemedicine|telehealth|ehr\b|emr\b|electronic\s*health|mental\s*health|behavioral\s*health|psychiatr|psycholog|counsel|therapy|rehab|physical\s*therapy|occupational\s*therapy|home\s*health|hospice|elder\s*care|senior\s*care|assisted\s*living|veterinar|vet\s*clinic|animal\s*hospital|wellness|fitness|gym\b|yoga|nutrition|supplement|vitamin|cbd\b|cannabis|marijuana)/i, "Healthcare"],
  [/\b(non-?\s*profit|nonprofit|501\s*\(?\s*c|foundation|charit|philanthrop|donor|fundrais|cause|mission-?\s*driven|social\s*impact|community\s*service|human\s*service|food\s*bank|shelter|advocacy|civic|volunteer|united\s*way|red\s*cross|salvation\s*army|ymca|ywca|habitat|humane\s*society|world\s*vision)/i, "Non-profit"],
  [/\b(government|gov\b|federal|state\s*agency|municipal|county\s*of|city\s*of|public\s*sector|public\s*safety|law\s*enforcement|police|fire\s*department|military|defense|pentagon|nasa|fbi|cia|dhs|homeland|veterans?\s*affairs|va\s*hospital|usda|epa|fda|fema)/i, "Government"],
  [/\b(university|college|school|academ|education|learning|student|teacher|professor|faculty|campus|tutor|curricul|k-?\s*12|preschool|kindergarten|elementary|middle\s*school|high\s*school|charter\s*school|montessori|e-?\s*learning|edtech|ed\s*tech|lms\b|course|training\s*platform)/i, "Education"],
  [/\b(construct|contractor|building\s*contractor|general\s*contractor|subcontractor|roofing|roofer|plumb|hvac|heating|cooling|air\s*condition|electric(?:al)?\s*contract|paving|excavat|demolit|concret|masonry|framing|drywall|insulation|flooring|tile|cabinet|remodel|renovation|home\s*improve|home\s*build|custom\s*home|residential\s*build|commercial\s*build|civil\s*engineer|structural\s*engineer|architect|landscape|hardscape|fence|deck\s*build|pool\s*build|solar\s*install|window|siding|gutter|painting\s*contract|waterproof|foundation\s*repair)/i, "Construction"],
  [/\b(real\s*estate|realty|realtor|property\s*manage|prop\s*mgmt|apartment|rental|tenant|landlord|lease|leasing|mortgage|title\s*company|escrow|apprais|home\s*sale|house\s*sale|mls\b|brokerage|commercial\s*real|residential\s*real|condo|townhome|housing|multifamily|single\s*family|reit\b|property\s*invest|land\s*develop|real\s*estate\s*develop|property\s*development|self\s*storage|storage\s*unit|cowork|co-work|office\s*space|flex\s*space)/i, "Real Estate / Prop Mgmt"],
  [/\b(family\s*office|single\s*family\s*office|multi\s*family\s*office|wealth\s*management|private\s*wealth|high\s*net\s*worth|hnw|uhnw|estate\s*plan|trust\s*management|family\s*trust|generational\s*wealth|legacy\s*plan)/i, "Family Office"],
  [/\b(bank|banking|credit\s*union|fintech|fin\s*tech|payment|payroll|lending|loan|mortgage\s*lend|invest(?:ment|ing|or)|venture\s*capital|private\s*equity|hedge\s*fund|asset\s*manage|portfolio|wealth\s*manage|financ|capital\s*market|stock|trading|brokerage|securities|insurance|insur(?:ance|tech)|underwriting|actuar|risk\s*manage|compliance|regtech|reg\s*tech|anti-?\s*money|aml\b|kyc\b|blockchain|crypto|defi\b|bitcoin|ethereum|accounting|account(?:ant|ing)|bookkeep|cpa\b|tax\s*prep|tax\s*service|tax\s*consult|audit|fractional\s*cfo|cfo\s*service|controller|financial\s*plan|cfp\b)/i, "Financial Services"],
  [/\b(software|saas\b|platform|app\b|apps\b|tech(?:nology)?|cloud|data\s*(?:analytics|science|engineer|platform|management)|artificial\s*intelligence|\bai\b|machine\s*learning|\bml\b|deep\s*learning|neural|nlp\b|computer\s*vision|automat|robot|iot\b|internet\s*of\s*things|cyber\s*security|infosec|information\s*security|devops|dev\s*ops|api\b|sdk\b|open\s*source|startup|silicon|venture|semiconductor|chip|processor|hardware|server|hosting|data\s*center|network|telecom|wireless|5g\b|fiber|broadband|isp\b|erp\b|crm\b|hris\b|hrms|hr\s*tech|proptech|prop\s*tech|legaltech|legal\s*tech|martech|mar\s*tech|adtech|ad\s*tech|regtech|healthtech|health\s*tech|cleantech|clean\s*tech|agtech|ag\s*tech|foodtech|food\s*tech|edtech|govtech|gov\s*tech|spacetech|biotech|nanotech|quantum|web3|metaverse|vr\b|ar\b|virtual\s*reality|augmented\s*reality|gaming|game\s*develop|mobile\s*app|web\s*develop|full\s*stack|front\s*end|back\s*end|database|sql|nosql|big\s*data|hadoop|spark|kafka|docker|kubernetes|aws|azure|gcp|google\s*cloud)/i, "Technology"],
  [/\b(manufactur|factory|plant\b|assembl|fabricat|machin(?:ing|e\s*shop)|cnc\b|injection\s*mold|die\s*cast|forg|stamp|weld|steel|metal|aluminum|plastic|polymer|rubber|composit|chemical|industr|warehouse|distribution|logistics|supply\s*chain|freight|shipping|trucking|transport|packag|bottl|brew|distill|winery|food\s*produc|food\s*process|beverage|dairy|meat|poultry|seafood|grain|flour|sugar|oil\s*refin|petroleum|natural\s*gas|mining|mineral|lumber|timber|paper|pulp|textile|fabric|apparel\s*manufactur|furniture\s*manufactur|glass|ceramic|cement|brick|aggregate|asphalt)/i, "Manufacturing"],
  [/\b(media|broadcast|television|\btv\b|radio|podcast|stream|content\s*creat|video\s*produc|film|movie|cinema|entertain|music|record\s*label|publish|magazine|newspaper|journal|news|press|editorial|advertising|ad\s*agency|creative\s*agency|digital\s*agency|marketing\s*agency|pr\s*agency|public\s*relation|brand|design\s*agency|graphic\s*design|ux\b|ui\b|web\s*design|photography|videograph|animation|production\s*company|production\s*studio|post\s*production|vfx|visual\s*effects|esports|e-?\s*sports)/i, "Media / Telecom"],
  [/\b(retail|store|shop|e-?\s*commerce|ecommerce|online\s*store|marketplace|merchant|consumer|brand|dtc\b|d2c\b|direct\s*to\s*consumer|wholesale|distribut|grocery|supermarket|convenience|boutique|fashion|clothing|apparel|shoes|jewelry|accessori|beauty|cosmetic|skincare|haircare|fragrance|luxury|home\s*goods|home\s*decor|furniture\s*retail|pet\s*supply|pet\s*store|toy|gift|book\s*store|sport(?:s|ing)\s*good|outdoor|camping|bike|bicycle|auto\s*parts|auto\s*dealer|car\s*dealer|dealership)/i, "Retail"],
  [/\b(consult|advisory|advisor|law\s*firm|legal|attorney|lawyer|litigation|patent|trademark|intellectual\s*property|staffing|recruit|headhunt|talent|human\s*resource|hr\s*consult|management\s*consult|strategy\s*consult|business\s*consult|it\s*consult|it\s*service|managed\s*service|outsourc|bpo\b|market\s*research|research\s*firm|analyst|data\s*consult|project\s*manage|program\s*manage|change\s*manage|organization\s*develop|leadership|executive\s*coach|business\s*coach|professional\s*service|engineer(?:ing)?\s*(?:firm|service|consult)|survey|inspection|testing\s*lab|certification|quality\s*assur|translation|interpret|localization)/i, "Professional Services"],
];

// Sub-industry text rules (primary → [[pattern, text], ...])
const SUB_INDUSTRY = {
  "Healthcare": [
    [/dental|dentist|orthodont/i, "Dental Services"],
    [/mental\s*health|behavioral|psychiatr|psycholog|counsel/i, "Mental Health Services"],
    [/biotech|biopharm|therapeut|drug\s*develop/i, "Biotechnology"],
    [/pharma|rx\b/i, "Pharmaceuticals"],
    [/med\s*device|medical\s*device/i, "Medical Devices"],
    [/telemedicine|telehealth|health\s*tech|healthtech/i, "Health Technology"],
    [/veterinar|vet\s*clinic|animal/i, "Veterinary Services"],
    [/wellness|fitness|gym|yoga|nutrition/i, "Health and Wellness"],
    [/home\s*health|hospice|elder|senior|assisted/i, "Home Health Care"],
    [/hospital|clinic|medical\s*center/i, "Hospital and Health Care"],
  ],
  "Technology": [
    [/cyber|infosec|security/i, "Cybersecurity"],
    [/\bai\b|artificial\s*intelligence|machine\s*learn/i, "Artificial Intelligence"],
    [/cloud|hosting|data\s*center/i, "Cloud Infrastructure"],
    [/fintech|fin\s*tech/i, "Financial Technology"],
    [/saas|software\s*as/i, "SaaS Platform"],
    [/data\s*(?:analytics|science|engineer)/i, "Data Analytics"],
    [/automat|robot|iot/i, "Automation Technology"],
    [/erp|crm|hris|hrms/i, "Enterprise Software"],
    [/mobile|app\b/i, "Mobile Technology"],
    [/blockchain|crypto|web3|defi/i, "Blockchain Technology"],
    [/gaming|game/i, "Gaming Technology"],
    [/proptech|prop\s*tech/i, "Property Technology"],
    [/martech|mar\s*tech/i, "Marketing Technology"],
    [/semiconductor|chip|processor/i, "Semiconductors"],
    [/hardware|device|sensor/i, "Hardware Technology"],
  ],
  "Financial Services": [
    [/accounting|accountant|bookkeep|cpa|tax|audit|controller|fractional\s*cfo|cfo\s*service/i, "Accounting Services"],
    [/venture\s*capital|vc\b/i, "Venture Capital"],
    [/private\s*equity|pe\b/i, "Private Equity"],
    [/investment\s*manage|asset\s*manage|portfolio/i, "Investment Management"],
    [/insur/i, "Insurance"],
    [/bank|credit\s*union/i, "Banking"],
    [/payment|payroll/i, "Payments"],
    [/lend|loan|mortgage/i, "Lending"],
    [/wealth\s*manage|financial\s*plan/i, "Wealth Management"],
  ],
  "Construction": [
    [/roofing|roofer/i, "Roofing"],
    [/hvac|heating|cooling|air\s*condition/i, "HVAC Services"],
    [/plumb/i, "Plumbing"],
    [/electric/i, "Electrical Contracting"],
    [/solar/i, "Solar Installation"],
    [/landscape|hardscape/i, "Landscaping"],
    [/remodel|renovation|home\s*improve/i, "Home Renovation"],
    [/commercial/i, "Commercial Construction"],
    [/residential|home\s*build|custom\s*home/i, "Residential Construction"],
    [/paving|excavat|civil/i, "Civil Construction"],
  ],
  "Real Estate / Prop Mgmt": [
    [/property\s*manage|prop\s*mgmt/i, "Property Management"],
    [/commercial\s*real/i, "Commercial Real Estate"],
    [/mortgage|title|escrow/i, "Mortgage Services"],
    [/self\s*storage|storage/i, "Self Storage"],
    [/cowork|co-work|office\s*space/i, "Coworking Spaces"],
    [/develop/i, "Real Estate Development"],
    [/invest/i, "Real Estate Investment"],
  ],
  "Manufacturing": [
    [/food|beverage|brew|distill|winery|dairy|meat/i, "Food and Beverage"],
    [/chemical/i, "Chemical Manufacturing"],
    [/metal|steel|aluminum/i, "Metal Manufacturing"],
    [/plastic|polymer|rubber/i, "Plastics Manufacturing"],
    [/textile|fabric|apparel/i, "Textile Manufacturing"],
    [/furniture/i, "Furniture Manufacturing"],
    [/auto/i, "Automotive Manufacturing"],
    [/electronics|semiconductor/i, "Electronics Manufacturing"],
    [/logistics|supply\s*chain|freight|shipping|trucking/i, "Logistics and Supply Chain"],
  ],
  "Education": [
    [/university|college|higher\s*ed/i, "Higher Education"],
    [/k-?12|elementary|middle|high\s*school|charter|preschool|kindergarten|montessori/i, "K-12 Education"],
    [/e-?learning|edtech|online\s*learn|training\s*platform/i, "EdTech"],
    [/tutor|test\s*prep/i, "Tutoring Services"],
  ],
  "Non-profit": [
    [/foundation|philanthrop/i, "Foundation"],
    [/church|religious|faith|ministry/i, "Religious Organization"],
    [/advocacy|civic|policy/i, "Advocacy Organization"],
  ],
  "Media / Telecom": [
    [/advertis|ad\s*agency|marketing\s*agency|digital\s*agency|creative\s*agency/i, "Marketing and Advertising"],
    [/film|movie|cinema|production/i, "Film Production"],
    [/music|record\s*label/i, "Music"],
    [/publish|magazine|newspaper|news|press/i, "Publishing"],
    [/design|graphic|ux|ui|web\s*design/i, "Design Agency"],
    [/telecom|wireless|5g|fiber|broadband/i, "Telecommunications"],
  ],
  "Professional Services": [
    [/law|legal|attorney|lawyer|litigation/i, "Legal Services"],
    [/staffing|recruit|headhunt|talent/i, "Staffing and Recruiting"],
    [/management\s*consult|strategy\s*consult|business\s*consult/i, "Management Consulting"],
    [/it\s*consult|it\s*service|managed\s*service/i, "IT Services"],
    [/engineer/i, "Engineering Services"],
    [/market\s*research|research\s*firm/i, "Market Research"],
  ],
  "Retail": [
    [/fashion|clothing|apparel|shoes/i, "Fashion Retail"],
    [/beauty|cosmetic|skincare|haircare/i, "Beauty Products"],
    [/grocery|supermarket|food/i, "Grocery Retail"],
    [/auto|car|vehicle|dealer/i, "Auto Dealership"],
    [/e-?commerce|online\s*store|marketplace/i, "E-Commerce"],
  ],
};

// Default sub-industry labels when no sub-rule matches
const SUB_INDUSTRY_DEFAULTS = {
  "Healthcare": "Healthcare Services",
  "Technology": "Software Technology",
  "Financial Services": "Financial Services",
  "Construction": "General Contracting",
  "Real Estate / Prop Mgmt": "Real Estate",
  "Manufacturing": "Industrial Manufacturing",
  "Education": "Education Services",
  "Non-profit": "Non-profit Organization",
  "Media / Telecom": "Media Production",
  "Professional Services": "Professional Services",
  "Retail": "Retail",
  "Government": "Government Services",
  "Family Office": "Family Office",
  "Other": "General Business",
};

// HubSpot company `industry` enum mapping (primary → [[pattern, enum], ...])
const COMPANY_INDUSTRY_MAP = {
  "Healthcare": [
    [/dental/i, "HOSPITAL_HEALTH_CARE"],
    [/mental/i, "MENTAL_HEALTH_CARE"],
    [/biotech/i, "BIOTECHNOLOGY"],
    [/pharma/i, "PHARMACEUTICALS"],
    [/med.*device|medical.*device/i, "MEDICAL_DEVICES"],
    [/veterinar|animal/i, "VETERINARY"],
    [/wellness|fitness|gym|yoga/i, "HEALTH_WELLNESS_AND_FITNESS"],
    [/home.*health|hospice|elder|senior/i, "INDIVIDUAL_FAMILY_SERVICES"],
  ],
  "Technology": [
    [/cyber|security/i, "COMPUTER_NETWORK_SECURITY"],
    [/software|saas|platform/i, "COMPUTER_SOFTWARE"],
    [/hardware|device|sensor/i, "COMPUTER_HARDWARE"],
    [/semiconductor|chip/i, "SEMICONDUCTORS"],
    [/gaming|game/i, "COMPUTER_GAMES"],
    [/telecom|wireless/i, "TELECOMMUNICATIONS"],
  ],
  "Financial Services": [
    [/accounting|accountant|bookkeep|cpa|tax|audit|controller|cfo/i, "ACCOUNTING"],
    [/venture.*capital/i, "VENTURE_CAPITAL_PRIVATE_EQUITY"],
    [/private.*equity/i, "VENTURE_CAPITAL_PRIVATE_EQUITY"],
    [/invest/i, "INVESTMENT_MANAGEMENT"],
    [/insur/i, "INSURANCE"],
    [/bank|credit.*union/i, "BANKING"],
  ],
  "Real Estate / Prop Mgmt": [
    [/commercial/i, "COMMERCIAL_REAL_ESTATE"],
  ],
  "Manufacturing": [
    [/food|beverage|brew|distill|winery|dairy/i, "FOOD_PRODUCTION"],
    [/chemical/i, "CHEMICALS"],
    [/metal|steel/i, "MINING_METALS"],
    [/auto/i, "AUTOMOTIVE"],
    [/textile|fabric|apparel/i, "TEXTILES"],
    [/furniture/i, "FURNITURE"],
    [/logistics|supply.*chain|freight|shipping|trucking/i, "LOGISTICS_AND_SUPPLY_CHAIN"],
  ],
  "Education": [
    [/university|college|higher/i, "HIGHER_EDUCATION"],
    [/k-?12|elementary|middle|high.*school|charter|preschool/i, "PRIMARY_SECONDARY_EDUCATION"],
    [/e-?learning|edtech|online.*learn/i, "E_LEARNING"],
  ],
  "Non-profit": [
    [/church|religious|faith|ministry/i, "RELIGIOUS_INSTITUTIONS"],
  ],
  "Media / Telecom": [
    [/advertis|marketing.*agency|ad.*agency|digital.*agency/i, "MARKETING_AND_ADVERTISING"],
    [/film|movie|cinema|production/i, "MOTION_PICTURES_AND_FILM"],
    [/music/i, "MUSIC"],
    [/publish|magazine|newspaper/i, "PUBLISHING"],
    [/design|graphic|ux|ui/i, "DESIGN"],
    [/telecom|wireless|5g|fiber|broadband/i, "TELECOMMUNICATIONS"],
  ],
  "Professional Services": [
    [/law|legal|attorney|lawyer|litigation/i, "LAW_PRACTICE"],
    [/staffing|recruit|headhunt|talent/i, "STAFFING_AND_RECRUITING"],
    [/management.*consult|strategy.*consult|business.*consult/i, "MANAGEMENT_CONSULTING"],
    [/it.*consult|it.*service|managed.*service/i, "INFORMATION_TECHNOLOGY_AND_SERVICES"],
    [/engineer/i, "MECHANICAL_OR_INDUSTRIAL_ENGINEERING"],
    [/market.*research|research/i, "MARKET_RESEARCH"],
  ],
  "Retail": [
    [/fashion|clothing|apparel|shoes/i, "APPAREL_FASHION"],
    [/beauty|cosmetic|skincare/i, "COSMETICS"],
    [/grocery|supermarket/i, "SUPERMARKETS"],
    [/auto|car|vehicle|dealer/i, "AUTOMOTIVE"],
  ],
  "Other": [
    [/restaurant|food.*service|cater|bar\b|pub\b|cafe|coffee/i, "RESTAURANTS"],
    [/hotel|hospitality|resort|travel|tourism/i, "HOSPITALITY"],
    [/farm|ranch|agri|crop/i, "FARMING"],
    [/oil|gas|energy|petrol|natural.*gas/i, "OIL_ENERGY"],
    [/event|conference|exhibition|trade.*show/i, "EVENTS_SERVICES"],
    [/transport|trucking|railroad/i, "TRANSPORTATION_TRUCKING_RAILROAD"],
    [/environment|sustainab|renewable|solar|wind.*energy|clean.*energy/i, "RENEWABLES_ENVIRONMENT"],
  ],
};

// Defaults when no sub-pattern matches
const COMPANY_INDUSTRY_DEFAULTS = {
  "Healthcare": "HOSPITAL_HEALTH_CARE",
  "Technology": "INFORMATION_TECHNOLOGY_AND_SERVICES",
  "Financial Services": "FINANCIAL_SERVICES",
  "Construction": "CONSTRUCTION",
  "Real Estate / Prop Mgmt": "REAL_ESTATE",
  "Manufacturing": "MECHANICAL_OR_INDUSTRIAL_ENGINEERING",
  "Education": "EDUCATION_MANAGEMENT",
  "Non-profit": "NON_PROFIT_ORGANIZATION_MANAGEMENT",
  "Media / Telecom": "MEDIA_PRODUCTION",
  "Professional Services": "MANAGEMENT_CONSULTING",
  "Retail": "RETAIL",
  "Government": "GOVERNMENT_ADMINISTRATION",
  "Family Office": "INVESTMENT_MANAGEMENT",
  "Other": "CONSUMER_SERVICES",
};

// HubSpot contact `enterprise_smb_industry` label → internal enum value
const PRIMARY_LABEL_TO_ENUM = {
  "Real Estate / Prop Mgmt": "Real Estate",
  "Media / Telecom": "Media",
  "Government": "Industry",
  "Non-profit": "Non-profit",
  "Family Office": "Family Office",
  "Technology": "Technology",
  "Financial Services": "Financial Services",
  "Construction": "Construction",
  "Education": "Education",
  "Manufacturing": "Manufacturing",
  "Healthcare": "Healthcare",
  "Professional Services": "Professional Services",
  "Retail": "Retail",
  "Other": "Other",
};

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliArgs() {
  const args = process.argv.slice(2);
  const opts = {
    ownerId: null,
    targetOwnerId: null,
    dryRun: false,
    logFile: null,
    skipLifecycle: false,
    skipCustomerDedup: false,
    skipContactType: false,
    skipIcp: false,
    skipEnrichment: false,
    skipIndustry: false,
    skipLeadStatus: false,
    skipApollo: false,
    skipPdl: false,
    maxEnrich: null,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--owner-id":
        opts.ownerId = args[++i];
        break;
      case "--target-owner-id":
        opts.targetOwnerId = args[++i];
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--log-file":
        opts.logFile = args[++i];
        break;
      case "--skip-lifecycle":
        opts.skipLifecycle = true;
        break;
      case "--skip-customer-dedup":
        opts.skipCustomerDedup = true;
        break;
      case "--skip-contact-type":
        opts.skipContactType = true;
        break;
      case "--skip-icp":
        opts.skipIcp = true;
        break;
      case "--skip-enrichment":
        opts.skipEnrichment = true;
        break;
      case "--skip-industry":
        opts.skipIndustry = true;
        break;
      case "--skip-lead-status":
        opts.skipLeadStatus = true;
        break;
      case "--skip-apollo":
        opts.skipApollo = true;
        break;
      case "--skip-pdl":
        opts.skipPdl = true;
        break;
      case "--max-enrich":
        opts.maxEnrich = parseInt(args[++i], 10);
        break;
      default:
        console.error(`Unknown argument: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!opts.ownerId) {
    console.error("Error: --owner-id is required");
    process.exit(1);
  }
  // --target-owner-id is optional; no longer required for ICP or contact type cleanup

  if (!opts.logFile) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    opts.logFile = path.resolve(`bdr_pipeline_${opts.ownerId}_${ts}.csv`);
  } else {
    opts.logFile = path.resolve(opts.logFile);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function hubspotFetch(method, urlPath, body) {
  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${BASE}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
      console.log(`  Rate limited — waiting ${waitMs}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      lastError = new Error(`HubSpot ${res.status}: ${text}`);
      if (res.status >= 500 && attempt < MAX_RETRIES) {
        const waitMs = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  Server error ${res.status} — retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      throw lastError;
    }

    return res.json();
  }
  throw lastError || new Error("Max retries exceeded");
}

async function batchUpdateContacts(inputs) {
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const chunk = inputs.slice(i, i + BATCH_SIZE);
    await hubspotFetch("POST", "/crm/v3/objects/contacts/batch/update", { inputs: chunk });
    if (i + BATCH_SIZE < inputs.length) await sleep(300);
  }
}

async function batchUpdateCompanies(inputs) {
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const chunk = inputs.slice(i, i + BATCH_SIZE);
    await hubspotFetch("POST", "/crm/v3/objects/companies/batch/update", { inputs: chunk });
    if (i + BATCH_SIZE < inputs.length) await sleep(300);
  }
}

async function searchAllContacts(filters, properties, maxResults = 10000) {
  const all = [];
  let afterCursor;

  while (all.length < maxResults) {
    const body = {
      filterGroups: [{ filters }],
      properties,
      limit: SEARCH_LIMIT,
      sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
    };
    if (afterCursor) body.after = afterCursor;

    let data;
    try {
      data = await hubspotFetch("POST", "/crm/v3/objects/contacts/search", body);
    } catch (e) {
      // HubSpot 400 at 10k cursor limit — return what we have
      if (e.message && e.message.includes("400")) break;
      throw e;
    }
    all.push(...data.results);

    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  return all;
}

// ---------------------------------------------------------------------------
// ICP classification
// ---------------------------------------------------------------------------

function tokenize(jobtitle) {
  if (!jobtitle) return [];
  return jobtitle
    .toLowerCase()
    .split(/[\s,\/|&\-()]+/)
    .filter(Boolean);
}

function isIcp(jobtitle) {
  const words = tokenize(jobtitle);
  if (words.length === 0) return false;

  for (const token of ICP_SINGLE_TOKENS) {
    if (words.includes(token)) return true;
  }
  for (const compound of ICP_COMPOUND_TOKENS) {
    if (compound.every((t) => words.includes(t))) return true;
  }
  return false;
}

function hasActivity(props) {
  if (props.notes_last_updated) return true;
  if (parseInt(props.num_notes || "0", 10) > 0) return true;
  if (props.hs_sales_email_last_replied) return true;
  if (props.hs_last_sales_activity_timestamp) return true;
  if (parseInt(props.num_associated_deals || "0", 10) > 0) return true;
  if (props.hs_email_last_reply_date) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Industry classification helpers
// ---------------------------------------------------------------------------

function matchSub(text, rules) {
  if (!rules) return null;
  for (const [pattern, value] of rules) {
    if (pattern.test(text)) return value;
  }
  return null;
}

function classifyCompany(name, title, description, domain) {
  const text = `${name} ${title} ${description} ${domain}`.toLowerCase();

  let primary = "Other";
  for (const [pattern, label] of CLASSIFY_RULES) {
    if (pattern.test(text)) {
      primary = label;
      break;
    }
  }

  const industry = matchSub(text, SUB_INDUSTRY[primary]) || SUB_INDUSTRY_DEFAULTS[primary] || "General Business";
  const companyInd = matchSub(text, COMPANY_INDUSTRY_MAP[primary]) || COMPANY_INDUSTRY_DEFAULTS[primary] || "CONSUMER_SERVICES";

  return { primary, industry, companyIndustry: companyInd };
}

async function fetchHomepage(domain) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`https://${domain}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!res.ok) return { title: "", description: "", status: "error" };

    // Read first 50KB only
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (totalBytes < 50000) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    reader.cancel();

    const html = Buffer.concat(chunks).toString("utf-8");

    // Extract title with regex
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300) : "";

    // Extract meta description
    const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
      || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
    let description = descMatch ? descMatch[1].trim().slice(0, 500) : "";

    // Fallback to og:description
    if (!description) {
      const ogMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
        || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:description["'][^>]*>/i);
      if (ogMatch) description = ogMatch[1].trim().slice(0, 500);
    }

    return { title, description, status: "ok" };
  } catch {
    // Try http fallback
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(`http://${domain}`, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          Accept: "text/html",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);

      if (!res.ok) return { title: "", description: "", status: "error" };

      const reader = res.body.getReader();
      const chunks = [];
      let totalBytes = 0;
      while (totalBytes < 50000) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalBytes += value.length;
      }
      reader.cancel();

      const html = Buffer.concat(chunks).toString("utf-8");
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim().slice(0, 300) : "";
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
        || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*name=["']description["'][^>]*>/i);
      let description = descMatch ? descMatch[1].trim().slice(0, 500) : "";
      if (!description) {
        const ogMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([\s\S]*?)["'][^>]*>/i)
          || html.match(/<meta[^>]*content=["']([\s\S]*?)["'][^>]*property=["']og:description["'][^>]*>/i);
        if (ogMatch) description = ogMatch[1].trim().slice(0, 500);
      }
      return { title, description, status: "ok" };
    } catch {
      return { title: "", description: "", status: "error" };
    }
  }
}

// ---------------------------------------------------------------------------
// CSV logging
// ---------------------------------------------------------------------------

const CSV_HEADER =
  "step,id,firstname,lastname,jobtitle,action,details,timestamp\n";

function escapeCsv(value) {
  const s = String(value ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function logCsv(logFile, step, contact, action, details) {
  const p = contact.properties || {};
  const fields = [
    step,
    contact.id,
    p.firstname,
    p.lastname,
    p.jobtitle,
    action,
    details,
    new Date().toISOString(),
  ];
  fs.appendFileSync(logFile, fields.map(escapeCsv).join(",") + "\n");
}

// ---------------------------------------------------------------------------
// Step 1: Lifecycle Stage Correction
// ---------------------------------------------------------------------------

async function stepLifecycleCorrection(opts) {
  console.log("\n========================================");
  console.log("STEP 1: Lifecycle Stage Correction");
  console.log("========================================\n");

  // 1a. Find all contacts with lifecycle stage = opportunity for this owner
  console.log("Finding contacts with lifecycle stage = opportunity...");
  const opportunityContacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "lifecyclestage", operator: "EQ", value: "opportunity" },
    ],
    ["firstname", "lastname", "email", "jobtitle", "lifecyclestage"]
  );
  console.log(`  Found ${opportunityContacts.length} opportunity contacts`);

  if (opportunityContacts.length === 0) {
    console.log("  No opportunity contacts to correct. Skipping.");
    return 0;
  }

  // 1b. Get all open deals in the active pipeline
  console.log("Fetching open deals from active pipeline...");
  const allDeals = [];
  let afterCursor;
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "pipeline", operator: "EQ", value: ACTIVE_PIPELINE_ID },
          ],
        },
      ],
      properties: ["dealname", "dealstage"],
      limit: SEARCH_LIMIT,
    };
    if (afterCursor) body.after = afterCursor;
    const data = await hubspotFetch("POST", "/crm/v3/objects/deals/search", body);
    allDeals.push(...data.results);
    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  // Filter to open stages only
  const openDeals = allDeals.filter(
    (d) => !CLOSED_STAGES.includes(d.properties.dealstage)
  );
  console.log(`  Found ${openDeals.length} open deals`);

  // 1c. Get company IDs and domains for each open deal
  console.log("Fetching deal company associations and domains...");
  const dealCompanyIds = new Set();
  const dealCompanyDomains = new Set();

  for (const deal of openDeals) {
    try {
      const assocData = await hubspotFetch(
        "GET",
        `/crm/v4/objects/deals/${deal.id}/associations/companies`
      );
      for (const result of assocData.results || []) {
        const companyId = result.toObjectId;
        dealCompanyIds.add(String(companyId));

        // Fetch domain
        try {
          const company = await hubspotFetch(
            "GET",
            `/crm/v3/objects/companies/${companyId}?properties=domain`
          );
          const domain = (company.properties?.domain || "").trim().toLowerCase();
          if (domain) dealCompanyDomains.add(domain);
        } catch (e) {
          // skip
        }
      }
    } catch (e) {
      // skip
    }
    await sleep(50);
  }
  console.log(`  Deal companies: ${dealCompanyIds.size} IDs, ${dealCompanyDomains.size} domains`);

  // 1d. Check each opportunity contact against deal companies
  console.log("Cross-referencing contacts with deal companies...");
  const contactsToReset = [];

  for (const contact of opportunityContacts) {
    let matchesDeal = false;

    // Check company association
    try {
      const assocData = await hubspotFetch(
        "GET",
        `/crm/v4/objects/contacts/${contact.id}/associations/companies`
      );
      for (const result of assocData.results || []) {
        if (dealCompanyIds.has(String(result.toObjectId))) {
          matchesDeal = true;
          break;
        }
      }
    } catch (e) {
      // skip
    }

    // Check email domain
    if (!matchesDeal) {
      const email = (contact.properties?.email || "").trim().toLowerCase();
      if (email && email.includes("@")) {
        const domain = email.split("@")[1];
        if (dealCompanyDomains.has(domain)) {
          matchesDeal = true;
        }
      }
    }

    if (!matchesDeal) {
      contactsToReset.push(contact);
    }

    await sleep(50);
  }

  console.log(`  ${contactsToReset.length} contacts have no matching open deal → will reset to lead`);
  console.log(
    `  ${opportunityContacts.length - contactsToReset.length} contacts match an open deal → keeping as opportunity`
  );

  // 1e. Reset lifecycle stage: clear first, then set to lead
  if (contactsToReset.length > 0) {
    if (!opts.dryRun) {
      // Clear lifecycle stage
      const clearInputs = contactsToReset.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "" },
      }));
      await batchUpdateContacts(clearInputs);
      await sleep(500);

      // Set to lead
      const leadInputs = contactsToReset.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "lead" },
      }));
      await batchUpdateContacts(leadInputs);
    }

    for (const c of contactsToReset) {
      logCsv(opts.logFile, "lifecycle", c, "reset_to_lead", "opportunity → lead (no open deal)");
    }
    console.log(`  Updated ${contactsToReset.length} contacts: opportunity → lead`);
  }

  return contactsToReset.length;
}

// ---------------------------------------------------------------------------
// Step 2: Customer Deduplication
// ---------------------------------------------------------------------------

async function stepCustomerDedup(opts) {
  console.log("\n========================================");
  console.log("STEP 2: Customer Deduplication");
  console.log("========================================\n");

  // 2a. Fetch all companies with lifecyclestage = customer
  console.log("Fetching customer companies...");
  const customerCompanyIds = new Set();
  const customerCompanyNames = new Set();
  const customerCompanyDomains = new Set();

  let afterCursor;
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "lifecyclestage", operator: "EQ", value: "customer" },
          ],
        },
      ],
      properties: ["name", "domain"],
      limit: SEARCH_LIMIT,
    };
    if (afterCursor) body.after = afterCursor;

    let data;
    try {
      data = await hubspotFetch("POST", "/crm/v3/objects/companies/search", body);
    } catch (e) {
      if (e.message && e.message.includes("400")) break;
      throw e;
    }

    for (const company of data.results) {
      customerCompanyIds.add(String(company.id));
      const name = (company.properties?.name || "").trim().toLowerCase();
      if (name) customerCompanyNames.add(name);
      const domain = (company.properties?.domain || "").trim().toLowerCase();
      if (domain) customerCompanyDomains.add(domain);
    }

    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  console.log(`  Found ${customerCompanyIds.size} customer companies, ${customerCompanyDomains.size} domains`);

  // 2b. Fetch all Won deals and their associated company IDs and domains
  console.log("Fetching Won deals...");
  const allWonDeals = [];
  afterCursor = undefined;
  while (true) {
    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "dealstage", operator: "EQ", value: "closedwon" },
          ],
        },
      ],
      properties: ["dealname", "dealstage"],
      limit: SEARCH_LIMIT,
    };
    if (afterCursor) body.after = afterCursor;

    let data;
    try {
      data = await hubspotFetch("POST", "/crm/v3/objects/deals/search", body);
    } catch (e) {
      if (e.message && e.message.includes("400")) break;
      throw e;
    }
    allWonDeals.push(...data.results);
    if (!data.paging?.next?.after) break;
    afterCursor = data.paging.next.after;
  }

  console.log(`  Found ${allWonDeals.length} Won deals`);

  // 2c. Get company IDs and domains for each Won deal
  console.log("Fetching Won deal company associations and domains...");
  for (const deal of allWonDeals) {
    try {
      const assocData = await hubspotFetch(
        "GET",
        `/crm/v4/objects/deals/${deal.id}/associations/companies`
      );
      for (const result of assocData.results || []) {
        const companyId = String(result.toObjectId);
        customerCompanyIds.add(companyId);

        // Fetch company name and domain
        try {
          const company = await hubspotFetch(
            "GET",
            `/crm/v3/objects/companies/${companyId}?properties=domain,name`
          );
          const domain = (company.properties?.domain || "").trim().toLowerCase();
          if (domain) customerCompanyDomains.add(domain);
          const name = (company.properties?.name || "").trim().toLowerCase();
          if (name) customerCompanyNames.add(name);
        } catch (e) {
          // skip
        }
      }
    } catch (e) {
      // skip
    }
    await sleep(50);
  }

  console.log(`  After Won deals: ${customerCompanyIds.size} company IDs, ${customerCompanyNames.size} names, ${customerCompanyDomains.size} domains`);

  // 2d. Fetch all contacts for this BDR's owner ID
  console.log("Fetching BDR contacts...");
  const contacts = await searchAllContacts(
    [{ propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId }],
    ["firstname", "lastname", "company", "email", "associatedcompanyid", "lifecyclestage", "jobtitle"]
  );
  console.log(`  Found ${contacts.length} contacts`);

  // 2e. Check each contact against customer companies
  console.log("Cross-referencing contacts with customer companies...");
  const contactsToUpdate = [];

  for (const contact of contacts) {
    const props = contact.properties || {};
    const currentStage = (props.lifecyclestage || "").toLowerCase();

    // Skip contacts already marked as customer
    if (currentStage === "customer") continue;

    let isCustomerCompany = false;

    // Check associatedcompanyid
    const assocCompanyId = (props.associatedcompanyid || "").trim();
    if (assocCompanyId && customerCompanyIds.has(assocCompanyId)) {
      isCustomerCompany = true;
    }

    // Check company name
    if (!isCustomerCompany) {
      const companyName = (props.company || "").trim().toLowerCase();
      if (companyName && customerCompanyNames.has(companyName)) {
        isCustomerCompany = true;
      }
    }

    // Check email domain
    if (!isCustomerCompany) {
      const email = (props.email || "").trim().toLowerCase();
      if (email && email.includes("@")) {
        const domain = email.split("@")[1];
        if (!FREE_EMAIL_DOMAINS.has(domain) && customerCompanyDomains.has(domain)) {
          isCustomerCompany = true;
        }
      }
    }

    if (isCustomerCompany) {
      contactsToUpdate.push(contact);
    }
  }

  console.log(`  ${contactsToUpdate.length} contacts belong to customer companies but are not lifecycle stage "customer"`);

  // 2f. Update lifecycle stage: clear first, then set to customer
  if (contactsToUpdate.length > 0) {
    if (!opts.dryRun) {
      // Clear lifecycle stage
      const clearInputs = contactsToUpdate.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "" },
      }));
      await batchUpdateContacts(clearInputs);
      await sleep(500);

      // Set to customer
      const customerInputs = contactsToUpdate.map((c) => ({
        id: c.id,
        properties: { lifecyclestage: "customer" },
      }));
      await batchUpdateContacts(customerInputs);
    }

    for (const c of contactsToUpdate) {
      const prevStage = c.properties?.lifecyclestage || "(blank)";
      logCsv(opts.logFile, "customer_dedup", c, "set_customer", `${prevStage} -> customer (customer company match)`);
    }
    console.log(`  Updated ${contactsToUpdate.length} contacts to lifecycle stage "customer"`);
  }

  return contactsToUpdate.length;
}

// ---------------------------------------------------------------------------
// Step 3: Contact Type Cleanup
// ---------------------------------------------------------------------------

async function stepContactTypeCleanup(opts) {
  console.log("\n========================================");
  console.log("STEP 3: Contact Type Cleanup");
  console.log("========================================\n");

  // 2a. Find contacts for this owner with contact_type set to non-prospect values
  console.log("Finding contacts with non-prospect contact_type...");
  const nonProspectContacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "contact_type", operator: "HAS_PROPERTY" },
      { propertyName: "contact_type", operator: "NEQ", value: "Prospective Customer" },
    ],
    ["firstname", "lastname", "jobtitle", "contact_type"]
  );
  console.log(`  Found ${nonProspectContacts.length} non-prospect contacts`);

  // Tag non-prospect contacts as Disqualified (keep with current owner)
  let totalDisqualified = 0;
  if (nonProspectContacts.length > 0) {
    const inputs = nonProspectContacts.map((c) => ({
      id: c.id,
      properties: {
        hs_lead_status: "Disqualified",
      },
    }));

    if (!opts.dryRun) {
      await batchUpdateContacts(inputs);
    }

    for (const c of nonProspectContacts) {
      const ct = c.properties?.contact_type || "(blank)";
      logCsv(opts.logFile, "contact_type", c, "disqualified_non_prospect", `contact_type=${ct}`);
    }
    totalDisqualified = nonProspectContacts.length;
    console.log(`  Disqualified ${totalDisqualified} non-prospect contacts`);
  }

  // 2b. Tag remaining contacts with blank contact_type as "Prospective Customer"
  console.log("Finding contacts without contact_type...");
  const blankContacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "contact_type", operator: "NOT_HAS_PROPERTY" },
    ],
    ["firstname", "lastname", "jobtitle", "contact_type"]
  );
  console.log(`  Found ${blankContacts.length} contacts without contact_type`);

  let totalTagged = 0;
  if (blankContacts.length > 0) {
    const inputs = blankContacts.map((c) => ({
      id: c.id,
      properties: { contact_type: "Prospective Customer" },
    }));

    if (!opts.dryRun) {
      await batchUpdateContacts(inputs);
    }

    for (const c of blankContacts) {
      logCsv(opts.logFile, "contact_type", c, "tagged_prospect", "contact_type → Prospective Customer");
    }
    totalTagged = blankContacts.length;
    console.log(`  Tagged ${totalTagged} contacts as Prospective Customer`);
  }

  console.log(`\n  Contact Type Summary: disqualified=${totalDisqualified}, tagged=${totalTagged}`);
  return { totalDisqualified, totalTagged };
}

// ---------------------------------------------------------------------------
// Step 4: ICP Cleanup
// ---------------------------------------------------------------------------

async function stepIcpCleanup(opts) {
  console.log("\n========================================");
  console.log("STEP 4: ICP Cleanup");
  console.log("========================================\n");

  const SEARCH_PROPERTIES = [
    "jobtitle",
    "firstname",
    "lastname",
    "hs_lead_status",
    "notes_last_updated",
    "num_notes",
    "hs_sales_email_last_replied",
    "hs_last_sales_activity_timestamp",
    "num_associated_deals",
    "hs_email_last_reply_date",
  ];

  let totalDisqualified = 0;
  let totalRequalifiedWorking = 0;
  let totalRequalifiedNew = 0;
  let totalKept = 0;
  let passNumber = 0;
  const seenIds = new Set(); // persist across passes to avoid double-counting

  while (true) {
    passNumber++;
    console.log(`--- Pass ${passNumber} ---`);

    // Paginate through contacts (up to 10k per pass due to HubSpot cap)
    let afterCursor;
    let disqualifyBuffer = [];
    let requalifyBuffer = [];
    let passNonIcp = 0;
    let passIcp = 0;
    let passFetched = 0;

    while (true) {
      const body = {
        filterGroups: [
          { filters: [{ propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId }] },
        ],
        properties: SEARCH_PROPERTIES,
        limit: SEARCH_LIMIT,
        sorts: [{ propertyName: "hs_object_id", direction: "ASCENDING" }],
      };
      if (afterCursor) body.after = afterCursor;

      let data;
      try {
        data = await hubspotFetch("POST", "/crm/v3/objects/contacts/search", body);
      } catch (e) {
        if (e.message && e.message.includes("400")) break;
        throw e;
      }

      passFetched += data.results.length;

      for (const contact of data.results) {
        if (seenIds.has(contact.id)) continue;
        seenIds.add(contact.id);

        const title = contact.properties?.jobtitle;

        if (isIcp(title)) {
          passIcp++;
          const status = (contact.properties?.hs_lead_status || "").toLowerCase();
          if (status === "not in icp" || status === "disqualified") {
            requalifyBuffer.push(contact);
          } else {
            logCsv(opts.logFile, "icp", contact, "kept", `ICP: ${title}`);
            totalKept++;
          }
        } else {
          passNonIcp++;
          disqualifyBuffer.push(contact);

          // Flush disqualify buffer in chunks to avoid memory buildup
          if (disqualifyBuffer.length >= BATCH_SIZE) {
            const inputs = disqualifyBuffer.map((c) => ({
              id: c.id,
              properties: {
                hs_lead_status: "Disqualified",
              },
            }));
            if (!opts.dryRun) {
              try { await batchUpdateContacts(inputs); } catch (err) {
                console.error(`  Batch FAILED (disqualify): ${err.message}`);
              }
            }
            for (const c of disqualifyBuffer) {
              logCsv(opts.logFile, "icp", c, "disqualified", `non-ICP: ${c.properties?.jobtitle || "(blank)"}`);
            }
            console.log(`  Disqualified batch of ${disqualifyBuffer.length} non-ICP contacts`);
            disqualifyBuffer = [];
          }
        }
      }

      if (!data.paging?.next?.after) break;
      afterCursor = data.paging.next.after;
    }

    // Flush remaining disqualify buffer
    if (disqualifyBuffer.length > 0) {
      const inputs = disqualifyBuffer.map((c) => ({
        id: c.id,
        properties: {
          hs_lead_status: "Disqualified",
        },
      }));
      if (!opts.dryRun) {
        try { await batchUpdateContacts(inputs); } catch (err) {
          console.error(`  Batch FAILED (disqualify): ${err.message}`);
        }
      }
      for (const c of disqualifyBuffer) {
        logCsv(opts.logFile, "icp", c, "disqualified", `non-ICP: ${c.properties?.jobtitle || "(blank)"}`);
      }
      console.log(`  Disqualified ${disqualifyBuffer.length} non-ICP contacts`);
    }

    // Requalify ICP contacts
    if (requalifyBuffer.length > 0) {
      const workingContacts = requalifyBuffer.filter((c) => hasActivity(c.properties || {}));
      const newContacts = requalifyBuffer.filter((c) => !hasActivity(c.properties || {}));

      if (workingContacts.length > 0) {
        const inputs = workingContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "Has contacted but no response" },
        }));
        if (!opts.dryRun) await batchUpdateContacts(inputs);
        for (const c of workingContacts) {
          logCsv(opts.logFile, "icp", c, "requalified_working", c.properties?.jobtitle);
        }
        totalRequalifiedWorking += workingContacts.length;
        console.log(`  Requalified ${workingContacts.length} ICP contacts to Working`);
      }

      if (newContacts.length > 0) {
        const inputs = newContacts.map((c) => ({
          id: c.id,
          properties: { hs_lead_status: "No one has contacted them" },
        }));
        if (!opts.dryRun) await batchUpdateContacts(inputs);
        for (const c of newContacts) {
          logCsv(opts.logFile, "icp", c, "requalified_new", c.properties?.jobtitle);
        }
        totalRequalifiedNew += newContacts.length;
        console.log(`  Requalified ${newContacts.length} ICP contacts to New`);
      }
    }

    totalDisqualified += passNonIcp;

    console.log(`  Pass ${passNumber}: fetched=${passFetched}, ICP=${passIcp}, non-ICP=${passNonIcp}`);

    // If no non-ICP contacts were found this pass, we're done
    if (passNonIcp === 0) {
      console.log("  No more non-ICP contacts found. Done.");
      break;
    }

    // In dry-run mode, contacts aren't actually disqualified so subsequent
    // passes would find the same results. Run one pass only.
    if (opts.dryRun) {
      console.log("  Dry run — stopping after one pass.");
      break;
    }
  }

  console.log(`\n  ICP Summary: disqualified=${totalDisqualified}, requalified_working=${totalRequalifiedWorking}, requalified_new=${totalRequalifiedNew}, kept=${totalKept}`);
  return { totalDisqualified, totalRequalifiedWorking, totalRequalifiedNew, totalKept };
}

// ---------------------------------------------------------------------------
// Step 5: LinkedIn Enrichment
// ---------------------------------------------------------------------------

async function pdlMatchLinkedin(firstName, lastName, company, domain, email) {
  if (!PDL_KEY) return null;

  const params = new URLSearchParams();
  if (email) params.set("email", email);
  params.set("first_name", firstName);
  params.set("last_name", lastName);
  if (company) params.set("company", company);
  if (domain) params.set("website", domain);

  try {
    const res = await fetch(
      `https://api.peopledatalabs.com/v5/person/enrich?${params.toString()}`,
      {
        headers: { "X-Api-Key": PDL_KEY, Accept: "application/json" },
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.linkedin_url || null;
  } catch {
    return null;
  }
}

const APOLLO_WEBHOOK_URL = process.env.APOLLO_WEBHOOK_URL || "";

async function apolloMatchLinkedin(firstName, lastName, company, domain, email) {
  if (!APOLLO_KEY) return null;

  const payload = {
    first_name: firstName,
    last_name: lastName,
    organization_name: company,
    reveal_phone_number: true,
    reveal_personal_emails: true,
  };
  if (domain) payload.domain = domain;
  if (email) payload.email = email;
  if (APOLLO_WEBHOOK_URL) {
    payload.webhook_url = APOLLO_WEBHOOK_URL;
  }

  try {
    const escaped = JSON.stringify(payload).replace(/'/g, "'\\''");
    const cmd = [
      "curl -s -S --max-time 30",
      "-X POST 'https://api.apollo.io/api/v1/people/match'",
      "-H 'Content-Type: application/json'",
      `-H 'x-api-key: ${APOLLO_KEY}'`,
      `-d '${escaped}'`,
    ].join(" ");

    const stdout = execSync(cmd, { encoding: "utf-8", maxBuffer: 5 * 1024 * 1024 });
    const data = JSON.parse(stdout);
    return data?.person?.linkedin_url || null;
  } catch {
    return null;
  }
}

async function stepLinkedinEnrichment(opts) {
  console.log("\n========================================");
  console.log("STEP 5: LinkedIn Enrichment");
  console.log("========================================\n");

  if (!PDL_KEY && !APOLLO_KEY) {
    console.log("  No PDL_API or APOLLO_BULK_MATCH env vars set. Skipping enrichment.");
    return { found: 0, missed: 0 };
  }

  // Fetch remaining contacts for this owner
  console.log("Fetching owner's remaining contacts...");
  const contacts = await searchAllContacts(
    [{ propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId }],
    [
      "firstname",
      "lastname",
      "company",
      "jobtitle",
      "linkedin___profile",
      "hs_linkedin_url",
      "email",
      "domain",
    ]
  );
  console.log(`  Found ${contacts.length} contacts`);

  // Bidirectional sync linkedin___profile <-> hs_linkedin_url
  console.log("Syncing LinkedIn fields...");
  const syncUpdates = [];
  for (const c of contacts) {
    const p = c.properties || {};
    const custom = (p.linkedin___profile || "").trim();
    const hsUrl = (p.hs_linkedin_url || "").trim();

    if (custom && !hsUrl) {
      syncUpdates.push({ id: c.id, properties: { hs_linkedin_url: custom } });
      p.hs_linkedin_url = custom;
    } else if (hsUrl && !custom) {
      syncUpdates.push({ id: c.id, properties: { linkedin___profile: hsUrl } });
      p.linkedin___profile = hsUrl;
    }
  }

  if (syncUpdates.length > 0 && !opts.dryRun) {
    await batchUpdateContacts(syncUpdates);
  }
  console.log(`  Synced ${syncUpdates.length} contacts`);

  // Load previous misses
  const outputPath = path.resolve(`outputs/contact_enrichment/linkedin_enrich_${opts.ownerId}.json`);
  let previousMissIds = new Set();
  try {
    if (fs.existsSync(outputPath)) {
      const prev = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
      for (const m of prev.misses || []) {
        previousMissIds.add(String(m.id));
      }
    }
  } catch {
    // ignore
  }
  if (previousMissIds.size > 0) {
    console.log(`  Loaded ${previousMissIds.size} previous misses to skip`);
  }

  // Filter to those needing enrichment
  let toEnrich = [];
  let alreadyHave = 0;
  let skippedPrevious = 0;

  for (const c of contacts) {
    const custom = (c.properties?.linkedin___profile || "").trim();
    if (custom) {
      alreadyHave++;
    } else if (previousMissIds.has(c.id)) {
      skippedPrevious++;
    } else {
      toEnrich.push(c);
    }
  }

  console.log(`  ${alreadyHave} already have LinkedIn URL`);
  if (skippedPrevious > 0) console.log(`  ${skippedPrevious} skipped (previously missed)`);
  console.log(`  ${toEnrich.length} need enrichment`);

  if (opts.maxEnrich) {
    toEnrich = toEnrich.slice(0, opts.maxEnrich);
    console.log(`  Limiting to ${opts.maxEnrich} contacts`);
  }

  // Enrich — in dry-run mode, skip API calls to avoid burning credits
  const updates = [];
  const misses = [];
  let pdlFound = 0;
  let apolloFound = 0;

  if (opts.dryRun) {
    console.log(`\n  [DRY RUN] Skipping PDL/Apollo API calls to save credits`);
    console.log(`  ${toEnrich.length} contacts would be sent for enrichment`);
  } else {
    for (let i = 0; i < toEnrich.length; i++) {
      const c = toEnrich[i];
      const p = c.properties || {};
      const first = p.firstname || "";
      const last = p.lastname || "";
      const company = p.company || "";
      const domain = p.domain || "";
      const email = p.email || "";
      const title = p.jobtitle || "";

      if (!first && !last) continue;
      if (!company && !domain && !email) {
        misses.push({ id: c.id, name: `${first} ${last}`, company, title, reason: "no_company" });
        continue;
      }

      let linkedinUrl = null;

      // PDL first
      if (!opts.skipPdl && PDL_KEY) {
        linkedinUrl = await pdlMatchLinkedin(first, last, company, domain, email);
        if (linkedinUrl) {
          pdlFound++;
          console.log(`  [${i + 1}/${toEnrich.length}] PDL:    ${first} ${last} @ ${company} → ${linkedinUrl}`);
        }
      }

      // Apollo fallback
      if (!linkedinUrl && !opts.skipApollo && APOLLO_KEY) {
        linkedinUrl = await apolloMatchLinkedin(first, last, company, domain, email);
        if (linkedinUrl) {
          apolloFound++;
          console.log(`  [${i + 1}/${toEnrich.length}] Apollo: ${first} ${last} @ ${company} → ${linkedinUrl}`);
        }
      }

      if (linkedinUrl) {
        updates.push({
          id: c.id,
          properties: { linkedin___profile: linkedinUrl, hs_linkedin_url: linkedinUrl },
        });
        logCsv(opts.logFile, "enrichment", c, "linkedin_found", linkedinUrl);
      } else {
        console.log(`  [${i + 1}/${toEnrich.length}] MISS:   ${first} ${last} @ ${company} (${title})`);
        misses.push({ id: c.id, name: `${first} ${last}`, company, title, reason: "not_found" });
        logCsv(opts.logFile, "enrichment", c, "linkedin_miss", "not found");
      }

      await sleep(200);
    }
  }

  // Write updates to HubSpot
  if (updates.length > 0 && !opts.dryRun) {
    console.log(`\n  Updating ${updates.length} contacts in HubSpot...`);
    await batchUpdateContacts(updates);
  }

  // Save misses to JSON (skip in dry-run — found URLs aren't written either)
  if (!opts.dryRun) {
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const allMisses = [];
    const seenMissIds = new Set();
    // Keep previous misses
    try {
      if (fs.existsSync(outputPath)) {
        const prev = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
        for (const m of prev.misses || []) {
          if (m.id && !seenMissIds.has(String(m.id))) {
            allMisses.push(m);
            seenMissIds.add(String(m.id));
          }
        }
      }
    } catch {
      // ignore
    }
    for (const m of misses) {
      if (m.id && !seenMissIds.has(String(m.id))) {
        allMisses.push(m);
        seenMissIds.add(String(m.id));
      }
    }

    fs.writeFileSync(
      outputPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          owner_id: opts.ownerId,
          stats: { pdl_found: pdlFound, apollo_found: apolloFound, misses: allMisses.length },
          misses: allMisses,
        },
        null,
        2
      )
    );
    console.log(`  Results saved to: ${outputPath}`);
  }

  console.log(`\n  Enrichment Summary: PDL=${pdlFound}, Apollo=${apolloFound}, misses=${misses.length}`);

  return { found: pdlFound + apolloFound, missed: misses.length };
}

// ---------------------------------------------------------------------------
// Step 6: Primary Industry Enrichment
// ---------------------------------------------------------------------------

async function stepIndustryEnrichment(opts) {
  console.log("\n========================================");
  console.log("STEP 6: Primary Industry Enrichment");
  console.log("========================================\n");

  // Fetch contacts for this owner that don't have enterprise_smb_industry set
  console.log("Finding contacts without enterprise_smb_industry...");
  const contacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "enterprise_smb_industry", operator: "NOT_HAS_PROPERTY" },
    ],
    ["firstname", "lastname", "jobtitle", "company", "email", "associatedcompanyid"]
  );
  console.log(`  Found ${contacts.length} contacts without enterprise_smb_industry`);

  if (contacts.length === 0) {
    console.log("  All contacts already have industry set. Skipping.");
    return { classified: 0, skipped: 0 };
  }

  // Group by company name, extract email domains
  const companies = {}; // companyName → { contactIds: [], domains: Set, associatedCompanyId: "" }
  let noCompany = 0;

  for (const c of contacts) {
    const comp = (c.properties?.company || "").trim();
    if (!comp) {
      noCompany++;
      continue;
    }
    if (!companies[comp]) {
      companies[comp] = { contactIds: [], domains: new Set(), associatedCompanyId: "" };
    }
    companies[comp].contactIds.push(c.id);

    // Track associated company ID for company-level updates
    const assocId = c.properties?.associatedcompanyid || "";
    if (assocId) companies[comp].associatedCompanyId = assocId;

    const email = (c.properties?.email || "").trim().toLowerCase();
    if (email && email.includes("@")) {
      const domain = email.split("@")[1];
      if (!FREE_EMAIL_DOMAINS.has(domain)) {
        companies[comp].domains.add(domain);
      }
    }
  }

  const companyNames = Object.keys(companies);
  console.log(`  ${companyNames.length} unique companies to classify`);
  if (noCompany > 0) console.log(`  ${noCompany} contacts skipped (no company name)`);

  // Fetch homepage title + description for each unique domain
  const domainDescriptions = {}; // domain → { title, description }
  const uniqueDomains = new Set();
  for (const info of Object.values(companies)) {
    for (const d of info.domains) uniqueDomains.add(d);
  }

  if (opts.dryRun) {
    console.log(`\n  [DRY RUN] Skipping homepage fetches for ${uniqueDomains.size} domains`);
  } else {
    console.log(`\n  Fetching homepages for ${uniqueDomains.size} unique domains...`);
    let domIdx = 0;
    for (const domain of uniqueDomains) {
      domIdx++;
      const result = await fetchHomepage(domain);
      domainDescriptions[domain] = result;
      const title = (result.title || "(none)").slice(0, 50);
      console.log(`    [${domIdx}/${uniqueDomains.size}] ${result.status}: ${domain} → ${title}`);
      await sleep(300);
    }
  }

  // Classify each company
  const contactUpdates = [];
  const companyUpdates = {}; // companyId → { industry: enum }
  let classified = 0;
  let noDomain = 0;

  for (const compName of companyNames) {
    const info = companies[compName];
    const domains = Array.from(info.domains);
    const domain = domains[0] || "";

    let title = "";
    let description = "";
    if (domain && domainDescriptions[domain]) {
      title = domainDescriptions[domain].title || "";
      description = domainDescriptions[domain].description || "";
    }

    if (!domain) noDomain++;

    const result = classifyCompany(compName, title, description, domain);
    const enumVal = PRIMARY_LABEL_TO_ENUM[result.primary] || result.primary;

    // Truncate industry text to max 5 words
    let industryText = result.industry;
    const words = industryText.split(/\s+/);
    if (words.length > 5) industryText = words.slice(0, 5).join(" ");

    for (const contactId of info.contactIds) {
      const props = { enterprise_smb_industry: enumVal };
      if (industryText) props.industry = industryText;
      contactUpdates.push({ id: contactId, properties: props });

      // Find matching contact for CSV logging
      const contact = contacts.find((c) => c.id === contactId) || { id: contactId, properties: {} };
      logCsv(opts.logFile, "industry", contact, "classified", `${result.primary}: ${industryText}`);
    }

    // Company-level update
    if (info.associatedCompanyId && result.companyIndustry) {
      companyUpdates[info.associatedCompanyId] = { industry: result.companyIndustry };
    }

    classified++;
  }

  console.log(`\n  Classified ${classified} companies (${noDomain} without domain)`);
  console.log(`  Contact updates: ${contactUpdates.length}`);
  console.log(`  Company updates: ${Object.keys(companyUpdates).length}`);

  // Distribution
  const dist = {};
  for (const compName of companyNames) {
    const info = companies[compName];
    const domain = Array.from(info.domains)[0] || "";
    let title = "";
    let description = "";
    if (domain && domainDescriptions[domain]) {
      title = domainDescriptions[domain].title || "";
      description = domainDescriptions[domain].description || "";
    }
    const result = classifyCompany(compName, title, description, domain);
    dist[result.primary] = (dist[result.primary] || 0) + 1;
  }
  console.log("\n  Primary Industry Distribution:");
  for (const [ind, count] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ind.padEnd(30)} ${count}`);
  }

  // Save "Other" companies to JSON for follow-up research
  const otherCompanies = [];
  for (const compName of companyNames) {
    const info = companies[compName];
    const domains = Array.from(info.domains);
    const domain = domains[0] || "";
    let title = "";
    let description = "";
    if (domain && domainDescriptions[domain]) {
      title = domainDescriptions[domain].title || "";
      description = domainDescriptions[domain].description || "";
    }
    const result = classifyCompany(compName, title, description, domain);
    if (result.primary === "Other") {
      otherCompanies.push({
        name: compName,
        domain: domain,
        contact_ids: info.contactIds,
        homepage_title: title,
        homepage_description: description,
      });
    }
  }

  if (otherCompanies.length > 0) {
    const outDir = path.resolve(__dirname, "..", "outputs", "contact_enrichment");
    fs.mkdirSync(outDir, { recursive: true });
    const otherFile = path.join(outDir, `industry_other_${opts.ownerId}.json`);
    const otherPayload = {
      timestamp: new Date().toISOString(),
      owner_id: opts.ownerId,
      companies: otherCompanies,
    };
    fs.writeFileSync(otherFile, JSON.stringify(otherPayload, null, 2));
    console.log(`\n  Saved ${otherCompanies.length} "Other" companies to ${otherFile}`);
  }

  // Push updates
  if (!opts.dryRun) {
    if (contactUpdates.length > 0) {
      console.log(`\n  Updating ${contactUpdates.length} contacts...`);
      await batchUpdateContacts(contactUpdates);
    }

    const companyList = Object.entries(companyUpdates).map(([id, props]) => ({
      id,
      properties: props,
    }));
    if (companyList.length > 0) {
      console.log(`  Updating ${companyList.length} companies...`);
      await batchUpdateCompanies(companyList);
    }
  }

  console.log(`\n  Industry Enrichment Summary: classified=${classified}, contact_updates=${contactUpdates.length}, company_updates=${Object.keys(companyUpdates).length}`);
  return { classified, skipped: noCompany };
}

// ---------------------------------------------------------------------------
// Step 7: Blank Lead Status Cleanup
// ---------------------------------------------------------------------------

async function stepBlankLeadStatus(opts) {
  console.log("\n========================================");
  console.log("STEP 7: Blank Lead Status Cleanup");
  console.log("========================================\n");

  const ACTIVITY_PROPERTIES = [
    "firstname",
    "lastname",
    "jobtitle",
    "hs_lead_status",
    "notes_last_updated",
    "num_notes",
    "hs_sales_email_last_replied",
    "hs_last_sales_activity_timestamp",
    "num_associated_deals",
    "hs_email_last_reply_date",
  ];

  console.log("Finding contacts with blank lead status...");
  const contacts = await searchAllContacts(
    [
      { propertyName: "hubspot_owner_id", operator: "EQ", value: opts.ownerId },
      { propertyName: "hs_lead_status", operator: "NOT_HAS_PROPERTY" },
    ],
    ACTIVITY_PROPERTIES
  );
  console.log(`  Found ${contacts.length} contacts with blank lead status`);

  if (contacts.length === 0) {
    console.log("  All contacts already have lead status. Skipping.");
    return { working: 0, newStatus: 0 };
  }

  const workingContacts = contacts.filter((c) => hasActivity(c.properties || {}));
  const newContacts = contacts.filter((c) => !hasActivity(c.properties || {}));

  console.log(`  ${workingContacts.length} have activity → Working`);
  console.log(`  ${newContacts.length} have no activity → New`);

  if (workingContacts.length > 0) {
    const inputs = workingContacts.map((c) => ({
      id: c.id,
      properties: { hs_lead_status: "Has contacted but no response" },
    }));
    if (!opts.dryRun) await batchUpdateContacts(inputs);
    for (const c of workingContacts) {
      logCsv(opts.logFile, "lead_status", c, "set_working", "blank → Has contacted but no response");
    }
  }

  if (newContacts.length > 0) {
    const inputs = newContacts.map((c) => ({
      id: c.id,
      properties: { hs_lead_status: "No one has contacted them" },
    }));
    if (!opts.dryRun) await batchUpdateContacts(inputs);
    for (const c of newContacts) {
      logCsv(opts.logFile, "lead_status", c, "set_new", "blank → No one has contacted them");
    }
  }

  console.log(`\n  Lead Status Summary: working=${workingContacts.length}, new=${newContacts.length}`);
  return { working: workingContacts.length, newStatus: newContacts.length };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!TOKEN) {
    console.error("Error: HUBSPOT_ACCESS_TOKEN environment variable is not set");
    process.exit(1);
  }

  const opts = parseCliArgs();

  console.log("=== BDR Lead Pipeline ===");
  console.log(`Owner ID:         ${opts.ownerId}`);
  console.log(`Dry run:          ${opts.dryRun}`);
  console.log(`Log file:         ${opts.logFile}`);
  console.log(`Steps:            ${[
    opts.skipLifecycle ? "" : "lifecycle",
    opts.skipCustomerDedup ? "" : "customer_dedup",
    opts.skipContactType ? "" : "contact_type",
    opts.skipIcp ? "" : "icp",
    opts.skipEnrichment ? "" : "enrichment",
    opts.skipIndustry ? "" : "industry",
    opts.skipLeadStatus ? "" : "lead_status",
  ]
    .filter(Boolean)
    .join(" → ")}`);

  // Initialize CSV log
  fs.writeFileSync(opts.logFile, CSV_HEADER);

  // Step 1: Lifecycle Stage Correction
  let lifecycleReset = 0;
  if (!opts.skipLifecycle) {
    lifecycleReset = await stepLifecycleCorrection(opts);
  }

  // Step 2: Customer Deduplication
  let customerDedupCount = 0;
  if (!opts.skipCustomerDedup) {
    customerDedupCount = await stepCustomerDedup(opts);
  }

  // Step 3: Contact Type Cleanup
  let contactTypeResults = { totalDisqualified: 0, totalTagged: 0 };
  if (!opts.skipContactType) {
    contactTypeResults = await stepContactTypeCleanup(opts);
  }

  // Step 4: ICP Cleanup
  let icpResults = { totalDisqualified: 0, totalRequalifiedWorking: 0, totalRequalifiedNew: 0, totalKept: 0 };
  if (!opts.skipIcp) {
    icpResults = await stepIcpCleanup(opts);
  }

  // Step 5: LinkedIn Enrichment
  let enrichResults = { found: 0, missed: 0 };
  if (!opts.skipEnrichment) {
    enrichResults = await stepLinkedinEnrichment(opts);
  }

  // Step 6: Primary Industry Enrichment
  let industryResults = { classified: 0, skipped: 0 };
  if (!opts.skipIndustry) {
    industryResults = await stepIndustryEnrichment(opts);
  }

  // Step 7: Blank Lead Status Cleanup
  let leadStatusResults = { working: 0, newStatus: 0 };
  if (!opts.skipLeadStatus) {
    leadStatusResults = await stepBlankLeadStatus(opts);
  }

  // Final summary
  console.log("\n========================================");
  console.log("FINAL SUMMARY");
  console.log("========================================");
  if (!opts.skipLifecycle) {
    console.log(`Lifecycle corrections:    ${lifecycleReset} contacts reset to lead`);
  }
  if (!opts.skipCustomerDedup) {
    console.log(`Customer dedup:           ${customerDedupCount} contacts set to customer`);
  }
  if (!opts.skipContactType) {
    console.log(`Contact type disqualified: ${contactTypeResults.totalDisqualified} non-prospects`);
    console.log(`Contact type tagged:      ${contactTypeResults.totalTagged} as Prospective Customer`);
  }
  if (!opts.skipIcp) {
    console.log(`ICP disqualified:         ${icpResults.totalDisqualified}`);
    console.log(`ICP requalified Working:  ${icpResults.totalRequalifiedWorking}`);
    console.log(`ICP requalified New:      ${icpResults.totalRequalifiedNew}`);
    console.log(`ICP kept:                 ${icpResults.totalKept}`);
  }
  if (!opts.skipEnrichment) {
    console.log(`LinkedIn found:           ${enrichResults.found}`);
    console.log(`LinkedIn missed:          ${enrichResults.missed}`);
  }
  if (!opts.skipIndustry) {
    console.log(`Industry classified:      ${industryResults.classified} companies`);
    console.log(`Industry skipped:         ${industryResults.skipped} (no company name)`);
  }
  if (!opts.skipLeadStatus) {
    console.log(`Lead status Working:      ${leadStatusResults.working}`);
    console.log(`Lead status New:          ${leadStatusResults.newStatus}`);
  }
  console.log(`Audit log:                ${opts.logFile}`);
  if (opts.dryRun) {
    console.log("\n** DRY RUN — no changes were made **");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
