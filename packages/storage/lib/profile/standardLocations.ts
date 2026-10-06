/**
 * Standardized Location Database and Autocomplete Recommendation System
 * Formatted as "City, State, Country" to match LinkedIn, Indeed, and Naukri standards.
 */

export interface StandardLocation {
  /** Full standard formatted string: "City, State, Country" (e.g. "Bengaluru, Karnataka, India") */
  formatted: string;
  /** City name */
  city: string;
  /** State or Province */
  state?: string;
  /** Country name */
  country: string;
  /** Target platforms that recognize this format */
  platforms: ('linkedin' | 'naukri' | 'indeed')[];
  /** Alternative names, common aliases, abbreviations for fast fuzzy matching */
  aliases: string[];
  /** Flag for prominent quick-recommendation chips */
  isPopular?: boolean;
  /** Category */
  category: 'india_hub' | 'global_hub' | 'remote';
}

export const STANDARD_LOCATIONS: StandardLocation[] = [
  // ================= INDIA TECH HUBS & MAJOR CITIES =================
  {
    formatted: 'Bengaluru, Karnataka, India',
    city: 'Bengaluru',
    state: 'Karnataka',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Bangalore', 'BLR', 'Bengaluru Urban', 'Silicon Valley of India', 'Electronic City', 'Whitefield'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Hyderabad, Telangana, India',
    city: 'Hyderabad',
    state: 'Telangana',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Secunderabad', 'HYD', 'Cyberabad', 'HITEC City', 'Gachibowli', 'Madhapur'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Pune, Maharashtra, India',
    city: 'Pune',
    state: 'Maharashtra',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['PNQ', 'Hinjewadi', 'Magarpatta', 'Kharadi', 'Viman Nagar', 'Baner'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Delhi / NCR, India',
    city: 'Delhi',
    state: 'Delhi',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['New Delhi', 'NCR', 'Delhi NCR', 'National Capital Region', 'DL'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Mumbai, Maharashtra, India',
    city: 'Mumbai',
    state: 'Maharashtra',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Bombay', 'BOM', 'Navi Mumbai', 'Thane', 'Andheri', 'BKC', 'Bandra'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Gurugram, Haryana, India',
    city: 'Gurugram',
    state: 'Haryana',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Gurgaon', 'GGN', 'Cyber City', 'Golf Course Road', 'Sohna Road'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Noida, Uttar Pradesh, India',
    city: 'Noida',
    state: 'Uttar Pradesh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Greater Noida', 'Sector 62', 'Sector 125', 'Sector 135', 'Gautam Buddha Nagar'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Chennai, Tamil Nadu, India',
    city: 'Chennai',
    state: 'Tamil Nadu',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Madras', 'MAA', 'OMR', 'Old Mahabalipuram Road', 'Tidel Park', 'Velachery'],
    isPopular: true,
    category: 'india_hub',
  },
  {
    formatted: 'Kolkata, West Bengal, India',
    city: 'Kolkata',
    state: 'West Bengal',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Calcutta', 'CCU', 'Salt Lake', 'Sector V', 'New Town'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Ahmedabad, Gujarat, India',
    city: 'Ahmedabad',
    state: 'Gujarat',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['AMD', 'Gandhinagar', 'GIFT City', 'SG Highway', 'Prahlad Nagar'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Kochi, Kerala, India',
    city: 'Kochi',
    state: 'Kerala',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Cochin', 'COK', 'Ernakulam', 'Infopark', 'Kakkanad'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Thiruvananthapuram, Kerala, India',
    city: 'Thiruvananthapuram',
    state: 'Kerala',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Trivandrum', 'TRV', 'Technopark', 'Kazhakkoottam'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Chandigarh, India',
    city: 'Chandigarh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['IXC', 'Mohali', 'Panchkula', 'Tricity', 'IT Park'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Jaipur, Rajasthan, India',
    city: 'Jaipur',
    state: 'Rajasthan',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['JAI', 'Pink City', 'Sitapura', 'Malviya Nagar'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Indore, Madhya Pradesh, India',
    city: 'Indore',
    state: 'Madhya Pradesh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['IDR', 'Super Corridor', 'Vijay Nagar'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Coimbatore, Tamil Nadu, India',
    city: 'Coimbatore',
    state: 'Tamil Nadu',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['CJB', 'Saravanampatti', 'Tidel Park Coimbatore'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Bhubaneswar, Odisha, India',
    city: 'Bhubaneswar',
    state: 'Odisha',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['BBI', 'Infocity', 'Patia'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Lucknow, Uttar Pradesh, India',
    city: 'Lucknow',
    state: 'Uttar Pradesh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['LKO', 'Gomti Nagar', 'HCL IT City'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Visakhapatnam, Andhra Pradesh, India',
    city: 'Visakhapatnam',
    state: 'Andhra Pradesh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Vizag', 'VTZ', 'Madhurawada'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Nagpur, Maharashtra, India',
    city: 'Nagpur',
    state: 'Maharashtra',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['NAG', 'MIHAN', 'IT Park Nagpur'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Mysuru, Karnataka, India',
    city: 'Mysuru',
    state: 'Karnataka',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Mysore', 'MYQ', 'Hebbal Industrial Area'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Mangaluru, Karnataka, India',
    city: 'Mangaluru',
    state: 'Karnataka',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Mangalore', 'IXE'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Surat, Gujarat, India',
    city: 'Surat',
    state: 'Gujarat',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['STV'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Vadodara, Gujarat, India',
    city: 'Vadodara',
    state: 'Gujarat',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Baroda', 'BDQ'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Bhopal, Madhya Pradesh, India',
    city: 'Bhopal',
    state: 'Madhya Pradesh',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['BHO'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Patna, Bihar, India',
    city: 'Patna',
    state: 'Bihar',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['PAT'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Ranchi, Jharkhand, India',
    city: 'Ranchi',
    state: 'Jharkhand',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['IXR'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Dehradun, Uttarakhand, India',
    city: 'Dehradun',
    state: 'Uttarakhand',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['DED', 'IT Park Dehradun'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Guwahati, Assam, India',
    city: 'Guwahati',
    state: 'Assam',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['GAU', 'Tech City Guwahati'],
    isPopular: false,
    category: 'india_hub',
  },
  {
    formatted: 'Panaji, Goa, India',
    city: 'Panaji',
    state: 'Goa',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Goa', 'GOI'],
    isPopular: false,
    category: 'india_hub',
  },

  // ================= US & GLOBAL TECH HUBS =================
  {
    formatted: 'San Francisco, California, United States',
    city: 'San Francisco',
    state: 'California',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['SF', 'Bay Area', 'Silicon Valley', 'SFO'],
    isPopular: true,
    category: 'global_hub',
  },
  {
    formatted: 'San Jose, California, United States',
    city: 'San Jose',
    state: 'California',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['Silicon Valley', 'South Bay', 'SJC'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'New York, New York, United States',
    city: 'New York',
    state: 'New York',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['NYC', 'Manhattan', 'Brooklyn', 'New York City', 'Silicon Alley'],
    isPopular: true,
    category: 'global_hub',
  },
  {
    formatted: 'Seattle, Washington, United States',
    city: 'Seattle',
    state: 'Washington',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['SEA', 'Bellevue', 'Redmond', 'Puget Sound'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Austin, Texas, United States',
    city: 'Austin',
    state: 'Texas',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['ATX', 'Silicon Hills'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Boston, Massachusetts, United States',
    city: 'Boston',
    state: 'Massachusetts',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['Cambridge', 'BOS'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Chicago, Illinois, United States',
    city: 'Chicago',
    state: 'Illinois',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['CHI', 'Windy City'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Los Angeles, California, United States',
    city: 'Los Angeles',
    state: 'California',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['LA', 'Silicon Beach', 'LAX'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Dallas, Texas, United States',
    city: 'Dallas',
    state: 'Texas',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['DFW', 'Plano', 'Irving', 'Richardson'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Atlanta, Georgia, United States',
    city: 'Atlanta',
    state: 'Georgia',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['ATL', 'Buckhead', 'Midtown'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'London, England, United Kingdom',
    city: 'London',
    state: 'England',
    country: 'United Kingdom',
    platforms: ['linkedin', 'indeed'],
    aliases: ['UK', 'London City', 'LON', 'Silicon Roundabout'],
    isPopular: true,
    category: 'global_hub',
  },
  {
    formatted: 'Toronto, Ontario, Canada',
    city: 'Toronto',
    state: 'Ontario',
    country: 'Canada',
    platforms: ['linkedin', 'indeed'],
    aliases: ['GTA', 'YYZ', 'Waterloo'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Vancouver, British Columbia, Canada',
    city: 'Vancouver',
    state: 'British Columbia',
    country: 'Canada',
    platforms: ['linkedin', 'indeed'],
    aliases: ['YVR', 'BC'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Berlin, Germany',
    city: 'Berlin',
    country: 'Germany',
    platforms: ['linkedin', 'indeed'],
    aliases: ['BER', 'Deutschland'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Amsterdam, North Holland, Netherlands',
    city: 'Amsterdam',
    state: 'North Holland',
    country: 'Netherlands',
    platforms: ['linkedin', 'indeed'],
    aliases: ['AMS', 'Holland'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Dublin, Ireland',
    city: 'Dublin',
    country: 'Ireland',
    platforms: ['linkedin', 'indeed'],
    aliases: ['DUB', 'Silicon Docks'],
    isPopular: false,
    category: 'global_hub',
  },
  {
    formatted: 'Singapore',
    city: 'Singapore',
    country: 'Singapore',
    platforms: ['linkedin', 'indeed'],
    aliases: ['SG', 'Singapore City', 'SIN'],
    isPopular: true,
    category: 'global_hub',
  },
  {
    formatted: 'Dubai, United Arab Emirates',
    city: 'Dubai',
    country: 'United Arab Emirates',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['DXB', 'UAE', 'Dubai Internet City'],
    isPopular: true,
    category: 'global_hub',
  },
  {
    formatted: 'Sydney, New South Wales, Australia',
    city: 'Sydney',
    state: 'New South Wales',
    country: 'Australia',
    platforms: ['linkedin', 'indeed'],
    aliases: ['SYD', 'NSW'],
    isPopular: false,
    category: 'global_hub',
  },

  // ================= WORK MODES (ESPECIALLY FOR PREFERRED LOCATION) =================
  {
    formatted: 'Remote',
    city: 'Remote',
    country: 'Global',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Work from Home', 'WFH', 'Anywhere', 'Telecommute', 'Virtual'],
    isPopular: true,
    category: 'remote',
  },
  {
    formatted: 'Remote, India',
    city: 'Remote',
    country: 'India',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['India Remote', 'Remote India', 'WFH India'],
    isPopular: true,
    category: 'remote',
  },
  {
    formatted: 'Hybrid',
    city: 'Hybrid',
    country: 'Flexible',
    platforms: ['linkedin', 'naukri', 'indeed'],
    aliases: ['Flexible', 'Office + Remote'],
    isPopular: true,
    category: 'remote',
  },
  {
    formatted: 'Remote, United States',
    city: 'Remote',
    country: 'United States',
    platforms: ['linkedin', 'indeed'],
    aliases: ['US Remote', 'Remote USA'],
    isPopular: false,
    category: 'remote',
  },
];

/**
 * Quick popular recommendations for instant pill chips.
 */
export const POPULAR_LOCATIONS: StandardLocation[] = STANDARD_LOCATIONS.filter(l => l.isPopular);

/**
 * Searches the standardized location database.
 * Matches on city, state, country, and aliases with prefix weighting.
 */
export function searchStandardLocations(
  query: string,
  options?: {
    isPreferred?: boolean;
    limit?: number;
  },
): StandardLocation[] {
  const q = (query || '').trim().toLowerCase();
  const limit = options?.limit ?? 8;
  const isPreferred = options?.isPreferred ?? false;

  // Filter pool: exclude generic 'Remote' from Current Location by default unless explicitly typed
  let pool = STANDARD_LOCATIONS;
  if (!isPreferred && !q.includes('remote') && !q.includes('hybrid')) {
    pool = pool.filter(l => l.category !== 'remote');
  }

  if (!q) {
    // If query is empty, return popular locations
    return pool.filter(l => l.isPopular).slice(0, limit);
  }

  const exactMatches: StandardLocation[] = [];
  const prefixMatches: StandardLocation[] = [];
  const aliasMatches: StandardLocation[] = [];
  const substringMatches: StandardLocation[] = [];

  for (const item of pool) {
    const formattedLo = item.formatted.toLowerCase();
    const cityLo = item.city.toLowerCase();
    const stateLo = item.state?.toLowerCase() || '';
    const countryLo = item.country.toLowerCase();

    // 1. Exact match on formatted or city
    if (formattedLo === q || cityLo === q) {
      exactMatches.push(item);
      continue;
    }

    // 2. Prefix match on formatted or city
    if (formattedLo.startsWith(q) || cityLo.startsWith(q)) {
      prefixMatches.push(item);
      continue;
    }

    // 3. Match aliases (e.g. Bangalore -> Bengaluru, Gurgaon -> Gurugram, SF -> San Francisco)
    const hasAliasMatch = item.aliases.some(alias => alias.toLowerCase().startsWith(q) || alias.toLowerCase() === q);
    if (hasAliasMatch) {
      aliasMatches.push(item);
      continue;
    }

    // 4. Substring or State / Country match
    if (
      formattedLo.includes(q) ||
      cityLo.includes(q) ||
      stateLo.includes(q) ||
      countryLo.includes(q) ||
      item.aliases.some(alias => alias.toLowerCase().includes(q))
    ) {
      substringMatches.push(item);
    }
  }

  const combined = [...exactMatches, ...prefixMatches, ...aliasMatches, ...substringMatches];
  // Deduplicate
  const seen = new Set<string>();
  const result: StandardLocation[] = [];
  for (const item of combined) {
    if (!seen.has(item.formatted)) {
      seen.add(item.formatted);
      result.push(item);
      if (result.length >= limit) break;
    }
  }

  return result;
}

/**
 * Maps raw informal location strings to standardized "City, State, Country".
 * E.g. "Bangalore" -> "Bengaluru, Karnataka, India"
 * E.g. "Hyderabad" -> "Hyderabad, Telangana, India"
 * E.g. "Gurgaon" -> "Gurugram, Haryana, India"
 * E.g. "SF" -> "San Francisco, California, United States"
 */
export function standardizeLocationString(input: string): string {
  if (!input || typeof input !== 'string') return '';
  const trimmed = input.trim();
  if (!trimmed) return '';

  const q = trimmed.toLowerCase();

  // If already exactly matching a formatted standard location, keep it
  const exact = STANDARD_LOCATIONS.find(l => l.formatted.toLowerCase() === q);
  if (exact) return exact.formatted;

  // Check alias / city direct lookup
  for (const item of STANDARD_LOCATIONS) {
    if (item.city.toLowerCase() === q) return item.formatted;
    if (item.aliases.some(a => a.toLowerCase() === q)) return item.formatted;
  }

  // Prefix matching for single-word queries like "bengaluru", "pune"
  for (const item of STANDARD_LOCATIONS) {
    if (item.city.toLowerCase().startsWith(q)) return item.formatted;
    if (item.aliases.some(a => a.toLowerCase().startsWith(q))) return item.formatted;
  }

  // Fallback: return original trimmed string
  return trimmed;
}

/**
 * Parses a location string into separate City, State, Country components.
 * Essential for forms that break address down into individual fields.
 */
export function parseLocationParts(rawLocation?: string | null): {
  city: string;
  state?: string;
  country: string;
  isRemote: boolean;
} {
  if (!rawLocation || typeof rawLocation !== 'string') {
    return { city: '', country: '', isRemote: false };
  }

  const trimmed = rawLocation.trim();
  const lower = trimmed.toLowerCase();
  const isRemote = lower.includes('remote') || lower === 'wfh';

  // Check against standard locations
  const standard = STANDARD_LOCATIONS.find(l => l.formatted.toLowerCase() === lower || l.city.toLowerCase() === lower);
  if (standard) {
    return {
      city: standard.city,
      state: standard.state,
      country: standard.country,
      isRemote,
    };
  }

  // Decompose by comma
  const parts = trimmed
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
  if (parts.length === 3) {
    return { city: parts[0], state: parts[1], country: parts[2], isRemote };
  } else if (parts.length === 2) {
    return { city: parts[0], country: parts[1], isRemote };
  } else if (parts.length === 1) {
    return { city: parts[0], country: '', isRemote };
  }

  return { city: trimmed, country: '', isRemote };
}
