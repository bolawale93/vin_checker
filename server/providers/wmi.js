// Partial reference table of World Manufacturer Identifiers (VIN positions 1-3)
// and ISO 3780 country-code ranges. It is intentionally partial: an unknown
// WMI is reported as "not in local reference table", never guessed.
//
// Each entry is [make, description]. `make` is null where the WMI is shared by
// several brands, so no single make can be decoded from it reliably.
// Agencies can extend this table (or replace it with an authorised source).

export const WMI = {
  '1FA': ['Ford', 'Ford Motor Company, USA'], '1FB': ['Ford', 'Ford Motor Company, USA'], '1FC': ['Ford', 'Ford Motor Company, USA'],
  '1FD': ['Ford', 'Ford Motor Company, USA'], '1FM': ['Ford', 'Ford Motor Company, USA'], '1FT': ['Ford', 'Ford truck, USA'],
  '1G1': ['Chevrolet', 'General Motors, USA'], '1GC': ['Chevrolet', 'Chevrolet truck, USA'], '1GT': ['GMC', 'GMC truck, USA'],
  '1G6': ['Cadillac', 'General Motors, USA'], '1GN': ['Chevrolet', 'General Motors, USA'],
  '1HG': ['Honda', 'Honda of America, USA'], '19X': ['Honda', 'Honda, USA'], '19U': ['Acura', 'Acura, USA'],
  '1J4': ['Jeep', 'Jeep, USA'], '1C4': [null, 'FCA US (Chrysler/Jeep/Dodge), USA'], '1C6': ['Ram', 'FCA US, USA'],
  '1N4': ['Nissan', 'Nissan North America, USA'], '1N6': ['Nissan', 'Nissan truck, USA'], '1LN': ['Lincoln', 'Ford Motor Company, USA'],
  '1ME': ['Mercury', 'Ford Motor Company, USA'], '1VW': ['Volkswagen', 'Volkswagen, USA'], '1YV': ['Mazda', 'Mazda, USA'],
  '2FA': ['Ford', 'Ford Motor Company, Canada'], '2FM': ['Ford', 'Ford Motor Company, Canada'], '2G1': ['Chevrolet', 'General Motors, Canada'],
  '2HG': ['Honda', 'Honda, Canada'], '2HK': ['Honda', 'Honda, Canada'], '2HN': ['Acura', 'Honda (Acura), Canada'],
  '2T1': ['Toyota', 'Toyota Motor Manufacturing, Canada'], '2T2': ['Lexus', 'Toyota (Lexus), Canada'],
  '2T3': ['Toyota', 'Toyota Motor Manufacturing, Canada'], '2C3': ['Chrysler', 'Chrysler, Canada'],
  '3FA': ['Ford', 'Ford Motor Company, Mexico'], '3N1': ['Nissan', 'Nissan, Mexico'], '3VW': ['Volkswagen', 'Volkswagen, Mexico'],
  '3GN': ['Chevrolet', 'General Motors, Mexico'], '3HG': ['Honda', 'Honda, Mexico'],
  '4S3': ['Subaru', 'Subaru of Indiana, USA'], '4S4': ['Subaru', 'Subaru of Indiana, USA'], '4T1': ['Toyota', 'Toyota, USA'],
  '4T3': ['Toyota', 'Toyota, USA'], '4JG': ['Mercedes-Benz', 'Mercedes-Benz, USA'],
  '5FN': ['Honda', 'Honda, USA'], '5J6': ['Honda', 'Honda, USA'], '5NP': ['Hyundai', 'Hyundai, USA'], '5TD': ['Toyota', 'Toyota, USA'],
  '5TF': ['Toyota', 'Toyota truck, USA'], '5UX': ['BMW', 'BMW, USA'], '5XY': [null, 'Kia/Hyundai, USA'], '5YJ': ['Tesla', 'Tesla, USA'],
  '7SA': ['Tesla', 'Tesla, USA'],
  'JA3': ['Mitsubishi', 'Mitsubishi, Japan'], 'JA4': ['Mitsubishi', 'Mitsubishi, Japan'], 'JF1': ['Subaru', 'Subaru, Japan'],
  'JF2': ['Subaru', 'Subaru, Japan'], 'JHM': ['Honda', 'Honda, Japan'], 'JHL': ['Honda', 'Honda, Japan'], 'JM1': ['Mazda', 'Mazda, Japan'],
  'JMZ': ['Mazda', 'Mazda, Japan'], 'JN1': ['Nissan', 'Nissan, Japan'], 'JN8': ['Nissan', 'Nissan, Japan'], 'JS3': ['Suzuki', 'Suzuki, Japan'],
  'JTD': ['Toyota', 'Toyota, Japan'], 'JTE': ['Toyota', 'Toyota, Japan'], 'JTH': ['Lexus', 'Toyota (Lexus), Japan'],
  'JTJ': ['Lexus', 'Toyota (Lexus), Japan'], 'JTM': ['Toyota', 'Toyota, Japan'], 'JTN': ['Toyota', 'Toyota, Japan'],
  'JT2': ['Toyota', 'Toyota, Japan'], 'JT3': ['Toyota', 'Toyota, Japan'], 'JT4': ['Toyota', 'Toyota, Japan'],
  'KL1': [null, 'GM Korea (Daewoo/Chevrolet)'], 'KMH': ['Hyundai', 'Hyundai, South Korea'], 'KNA': ['Kia', 'Kia, South Korea'],
  'KND': ['Kia', 'Kia, South Korea'], 'KNM': ['Renault Samsung', 'Renault Samsung, South Korea'],
  'MA3': ['Suzuki', 'Maruti Suzuki, India'], 'MAL': ['Hyundai', 'Hyundai, India'], 'MR0': ['Toyota', 'Toyota, Thailand'],
  'MNT': ['Nissan', 'Nissan, Thailand'],
  'SAJ': ['Jaguar', 'Jaguar, UK'], 'SAL': ['Land Rover', 'Land Rover, UK'], 'SAR': ['Rover', 'Rover, UK'], 'SB1': ['Toyota', 'Toyota, UK'],
  'SCC': ['Lotus', 'Lotus, UK'], 'SCB': ['Bentley', 'Bentley, UK'], 'SHH': ['Honda', 'Honda, UK'], 'SJN': ['Nissan', 'Nissan, UK'],
  'TMB': ['Škoda', 'Škoda, Czech Republic'], 'TRU': ['Audi', 'Audi, Hungary'], 'TSM': ['Suzuki', 'Suzuki, Hungary'],
  'U5Y': ['Kia', 'Kia, Slovakia'], 'UU1': ['Dacia', 'Dacia, Romania'],
  'VF1': ['Renault', 'Renault, France'], 'VF3': ['Peugeot', 'Peugeot, France'], 'VF7': ['Citroën', 'Citroën, France'],
  'VSS': ['SEAT', 'SEAT, Spain'], 'VNK': ['Toyota', 'Toyota, France'],
  'WAU': ['Audi', 'Audi, Germany'], 'WA1': ['Audi', 'Audi SUV, Germany'], 'WBA': ['BMW', 'BMW, Germany'], 'WBS': ['BMW', 'BMW M, Germany'],
  'WBX': ['BMW', 'BMW SUV'], 'WDB': ['Mercedes-Benz', 'Mercedes-Benz, Germany'], 'WDD': ['Mercedes-Benz', 'Mercedes-Benz, Germany'],
  'WDC': ['Mercedes-Benz', 'Mercedes-Benz SUV, Germany'], 'W1K': ['Mercedes-Benz', 'Mercedes-Benz, Germany'],
  'W1N': ['Mercedes-Benz', 'Mercedes-Benz SUV, Germany'], 'WMW': ['MINI', 'MINI, Germany'], 'WP0': ['Porsche', 'Porsche, Germany'],
  'WP1': ['Porsche', 'Porsche SUV, Germany'], 'WVW': ['Volkswagen', 'Volkswagen, Germany'], 'WVG': ['Volkswagen', 'Volkswagen SUV, Germany'],
  'WV1': ['Volkswagen', 'Volkswagen Commercial, Germany'], 'WV2': ['Volkswagen', 'Volkswagen Commercial, Germany'],
  'W0L': [null, 'Opel/Vauxhall, Germany'],
  'YV1': ['Volvo', 'Volvo, Sweden'], 'YV4': ['Volvo', 'Volvo SUV, Sweden'], 'YS3': ['Saab', 'Saab, Sweden'],
  'ZAR': ['Alfa Romeo', 'Alfa Romeo, Italy'], 'ZFA': ['Fiat', 'Fiat, Italy'], 'ZFF': ['Ferrari', 'Ferrari, Italy'],
  'ZHW': ['Lamborghini', 'Lamborghini, Italy'],
};

// ISO 3780 region by first character.
export function regionFor(c) {
  if (/[A-H]/.test(c)) return 'Africa';
  if (/[J-R]/.test(c)) return 'Asia';
  if (/[S-Z]/.test(c)) return 'Europe';
  if (/[1-5]/.test(c)) return 'North America';
  if (/[67]/.test(c)) return 'Oceania';
  if (/[89]/.test(c)) return 'South America';
  return null;
}

// Country by first character (and second for shared ranges). Partial list.
const COUNTRY_RANGES = [
  ['A', 'A-H', 'South Africa'], ['J', null, 'Japan'], ['K', 'L-R', 'South Korea'], ['L', null, 'China'],
  ['M', 'A-E', 'India'], ['M', 'L-R', 'Thailand'], ['S', 'A-M', 'United Kingdom'], ['T', 'J-P', 'Czech Republic'],
  ['T', 'R-V', 'Hungary'], ['V', 'F-R', 'France'], ['V', 'S-W', 'Spain'], ['W', null, 'Germany'], ['Y', 'S-W', 'Sweden'],
  ['Z', 'A-R', 'Italy'], ['1', null, 'United States'], ['4', null, 'United States'], ['5', null, 'United States'],
  ['2', null, 'Canada'], ['3', 'A-W', 'Mexico'], ['6', 'A-W', 'Australia'], ['9', 'A-E', 'Brazil'], ['8', 'A-E', 'Argentina'],
];

export function countryFor(vin) {
  const [a, b] = vin;
  for (const [first, range, country] of COUNTRY_RANGES) {
    if (a !== first) continue;
    if (!range) return country;
    const [lo, hi] = range.split('-');
    if (b >= lo && b <= hi) return country;
  }
  return null;
}
