// Physical and astronomical constants. Sources:
//  - IAU 2012 Resolution B2 (au), JPL SSD astro_par (https://ssd.jpl.nasa.gov/astro_par.html)
//  - CODATA / SI defining constants (c)
//  - JPL Horizons output header: "Ecliptic of J2000.0 … IAU76 obliquity of 84381.448 arcseconds wrt ICRF X-Y plane"
//  - IERS Conventions 2010 Table 1.1

/** Astronomical unit in kilometres (IAU 2012, exact). */
export const AU_KM = 149597870.700;
/** Astronomical unit in metres (IAU 2012, exact). */
export const AU_M = 149597870700;
/** Speed of light in km/s (defining). */
export const C_KM_S = 299792.458;
/** Seconds per day. */
export const DAY_S = 86400;
/** Speed of light in AU per day (= 173.1446326742403). */
export const C_AU_DAY = C_KM_S * DAY_S / AU_KM;
/** Speed of light in AU per second. */
export const C_AU_S = C_KM_S / AU_KM;
/** Light-time for 1 au in seconds (= 499.004783836). */
export const LIGHT_TIME_AU_S = AU_KM / C_KM_S;
/** Julian date of J2000.0 (2000-01-01 12:00 TT). */
export const J2000 = 2451545.0;
/** Days per Julian century. */
export const DAYS_PER_CENTURY = 36525;
/** Days per thousand Julian years (VSOP87 time unit). */
export const DAYS_PER_TJY = 365250;
/** Days per Julian year. */
export const JULIAN_YEAR_DAYS = 365.25;
/** Mean obliquity of the ecliptic at J2000, IAU 1976, arcseconds (Horizons "Ecliptic of J2000.0"). */
export const EPS76_ARCSEC = 84381.448;
/** Same, radians. */
export const EPS76_RAD = (EPS76_ARCSEC / 3600) * (Math.PI / 180);
/** Arcseconds per radian. */
export const ARCSEC_PER_RAD = (180 / Math.PI) * 3600;
/** Degrees → radians. */
export const DEG = Math.PI / 180;
/** Radians → degrees. */
export const RAD = 180 / Math.PI;
/** Heliocentric gravitational constant, km^3/s^2 (DE440, JPL astro_par). */
export const GM_SUN_KM3_S2 = 132712440041.279419;
/** TT − TAI in seconds (defining). */
export const TT_MINUS_TAI_S = 32.184;
/** Solar radius, km (IAU 2015 nominal, NSSDC sun fact sheet). */
export const SUN_RADIUS_KM = 695700;
