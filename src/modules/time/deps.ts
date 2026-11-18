/** Abhängigkeiten der Zeiterfassung von anderen Modulen – nur über deren öffentliche queries. */
export { addDaysIso, localDateOf, localParts, offsetMinutes, zonedToUtc } from "@/modules/roster/queries";
export { austrianHolidays, countWorkingDays, isWorkingDay } from "@/modules/hr/queries";
