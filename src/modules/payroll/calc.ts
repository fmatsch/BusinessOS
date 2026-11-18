import { Decimal } from "@/lib/money";
import { z } from "zod";

/**
 * Lohnberechnung (Österreich, vereinfacht) – reine Funktionen ohne Datenbankzugriff.
 * Alle gesetzlichen Werte kommen aus der Parametertabelle (PayrollParams), nie aus dem Code.
 * Die mitgelieferten Werte sind ein ENTWURF und müssen vor dem Echtbetrieb durch die Lohnverrechnung/Steuerberatung geprüft werden.
 */

const pct = z.string().regex(/^\d+(\.\d+)?$/, "Prozentwert erwartet");
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, "Betrag erwartet");

export const paramsSchema = z.object({
  /** Sozialversicherung, Prozentsätze */
  sv: z.object({
    hbgMonthly: money,
    /** Höchstgrenze je Sonderzahlung (vereinfacht, keine Jahreskumulierung) */
    hbgSpecial: money,
    marginalLimit: money,
    marginalEmployerRate: pct,
    employee: z.object({ kv: pct, pv: pct, other: pct }),
    employeeSpecial: z.object({ kv: pct, pv: pct, av: pct, other: pct }),
    /** Arbeitslosenversicherung Arbeitnehmer nach Einkommen (Staffel): bis Betrag → Satz; letzter Eintrag ohne Grenze */
    avStaffel: z.array(z.object({ upTo: money.nullable(), rate: pct })).min(1),
    employer: z.object({ kv: pct, pv: pct, av: pct, uv: pct, iesg: pct, wbf: pct }),
  }),
  tax: z.object({
    /** Jahrestarif: bis Betrag → Satz; letzter Eintrag ohne Grenze */
    brackets: z.array(z.object({ upTo: money.nullable(), rate: pct })).min(1),
    verkehrsabsetzbetrag: money,
    familyBonusPerChild: money,
    specialFreeLimit: money,
    specialFreeAmount: money,
    specialRate: pct,
  }),
  employerLevies: z.object({ db: pct, dz: pct, kommst: pct, mvk: pct }),
});
export type PayrollParams = z.infer<typeof paramsSchema>;

/** Entwurfswerte (Österreich, 2026) – UNGEPRÜFT. Quelle und Prüfung liegen bei der Organisation (Parametersatz „geprüft“). */
export const DEFAULT_PARAMS_AT: PayrollParams = {
  sv: {
    hbgMonthly: "6450", hbgSpecial: "12900", marginalLimit: "551.10", marginalEmployerRate: "16.4",
    employee: { kv: "3.87", pv: "10.25", other: "1.0" },
    employeeSpecial: { kv: "3.57", pv: "10.25", av: "3.0", other: "0.5" },
    avStaffel: [{ upTo: "2225", rate: "0" }, { upTo: "2427", rate: "1" }, { upTo: "2629", rate: "2" }, { upTo: null, rate: "3" }],
    employer: { kv: "3.78", pv: "12.55", av: "3.0", uv: "1.1", iesg: "0.1", wbf: "0.5" },
  },
  tax: {
    brackets: [
      { upTo: "13539", rate: "0" }, { upTo: "21992", rate: "20" }, { upTo: "36458", rate: "30" },
      { upTo: "70365", rate: "40" }, { upTo: "104859", rate: "48" }, { upTo: "1000000", rate: "50" }, { upTo: null, rate: "55" },
    ],
    verkehrsabsetzbetrag: "496", familyBonusPerChild: "2000.16",
    specialFreeLimit: "2100", specialFreeAmount: "620", specialRate: "6",
  },
  employerLevies: { db: "3.7", dz: "0.3", kommst: "3", mvk: "1.53" },
};

export interface EmployeeInput {
  /** laufender Monatsbezug */
  monthlyGross: Decimal;
  /** zusätzliche laufende Bezüge dieses Monats (Zulagen, Überstunden) */
  regularExtra: Decimal;
  /** sonstiger Bezug dieses Monats (Urlaubs-/Weihnachtsgeld, Prämie) */
  special: Decimal;
  marginal: boolean;
  /** Freibetrag und Pendlerpauschale als monatliche Minderung der Steuerbemessung */
  allowanceMonthly: Decimal;
  commuterMonthly: Decimal;
  familyBonusChildren: number;
}

export interface Breakdown { [k: string]: string }
export interface Result {
  regularGross: string; specialGross: string; gross: string;
  svEmployee: string; svEmployeeBreakdown: Breakdown;
  taxBase: string; taxRegular: string; taxSpecial: string; tax: string;
  net: string;
  employerSv: string; employerSvBreakdown: Breakdown; employerLevies: string; employerLeviesBreakdown: Breakdown;
  employerCost: string;
  warnings: string[];
}

const D = (v: Decimal.Value) => new Decimal(v);
const r2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const share = (base: Decimal, percent: string) => r2(base.times(percent).div(100));
const s = (d: Decimal) => d.toFixed(2);

export class PayrollLimitError extends Error {}

/** Arbeitslosenversicherungs-Satz des Arbeitnehmers nach Staffel (Monatsbemessung). */
export function avRate(params: PayrollParams, monthlyBase: Decimal): string {
  for (const step of params.sv.avStaffel) if (step.upTo === null || monthlyBase.lte(step.upTo)) return step.rate;
  return params.sv.avStaffel[params.sv.avStaffel.length - 1]!.rate;
}

/** Progressiver Jahrestarif. */
export function annualTariff(params: PayrollParams, base: Decimal): Decimal {
  let tax = D(0), lower = D(0);
  for (const b of params.tax.brackets) {
    const upper = b.upTo === null ? null : D(b.upTo);
    const top = upper === null || base.lt(upper) ? base : upper;
    if (top.gt(lower)) tax = tax.plus(top.minus(lower).times(b.rate).div(100));
    if (upper === null || base.lte(upper)) break;
    lower = upper;
  }
  return tax;
}

export function calculateEmployee(params: PayrollParams, input: EmployeeInput): Result {
  const warnings: string[] = [];
  if (input.monthlyGross.lt(0) || input.regularExtra.lt(0) || input.special.lt(0)) throw new PayrollLimitError("Negative Beträge sind nicht zulässig");
  const regular = r2(input.monthlyGross.plus(input.regularExtra));
  const special = r2(input.special);
  const gross = regular.plus(special);

  // ── Sozialversicherung Arbeitnehmer ──
  let svEmpRegular = D(0), svEmpSpecial = D(0);
  const svb: Breakdown = {};
  const isMarginal = input.marginal && regular.lte(params.sv.marginalLimit);
  if (input.marginal && !isMarginal) warnings.push("Geringfügig Beschäftigte über der Geringfügigkeitsgrenze: voll versicherungspflichtig berechnet");
  if (isMarginal && special.gt(0)) throw new PayrollLimitError("Geringfügig Beschäftigte mit Sonderzahlung: nicht unterstützt (Grenze würde überschritten)");
  const svBase = D(Decimal.min(regular, params.sv.hbgMonthly));
  if (!isMarginal) {
    const kv = share(svBase, params.sv.employee.kv), pv = share(svBase, params.sv.employee.pv);
    const av = share(svBase, avRate(params, svBase)), other = share(svBase, params.sv.employee.other);
    svEmpRegular = kv.plus(pv).plus(av).plus(other);
    Object.assign(svb, { KV: s(kv), PV: s(pv), AV: s(av), Sonstige: s(other) });
    if (regular.gt(params.sv.hbgMonthly)) warnings.push("Höchstbeitragsgrundlage erreicht");
  }
  if (special.gt(0)) {
    const sb = D(Decimal.min(special, params.sv.hbgSpecial));
    const e = params.sv.employeeSpecial;
    const parts = { KV: share(sb, e.kv), PV: share(sb, e.pv), AV: share(sb, e.av), Sonstige: share(sb, e.other) };
    svEmpSpecial = parts.KV.plus(parts.PV).plus(parts.AV).plus(parts.Sonstige);
    svb["Sonderzahlung"] = s(svEmpSpecial);
    if (special.gt(params.sv.hbgSpecial)) warnings.push("Höchstgrenze für Sonderzahlungen erreicht (ohne Jahreskumulierung gerechnet)");
  }
  const svEmployee = svEmpRegular.plus(svEmpSpecial);

  // ── Lohnsteuer laufend (Jahresbemessung /12) ──
  const taxBaseMonthly = Decimal.max(0, regular.minus(svEmpRegular).minus(input.allowanceMonthly).minus(input.commuterMonthly));
  let annual = annualTariff(params, taxBaseMonthly.times(12));
  annual = Decimal.max(0, annual.minus(params.tax.verkehrsabsetzbetrag).minus(D(params.tax.familyBonusPerChild).times(input.familyBonusChildren)));
  const taxRegular = r2(annual.div(12));

  // ── Lohnsteuer sonstiger Bezug (feste 6 %, nur innerhalb des Sechstels, ohne Jahreskumulierung) ──
  let taxSpecial = D(0);
  if (special.gt(0)) {
    const specialNet = special.minus(svEmpSpecial);
    const sixth = regular.times(12).div(6);
    if (specialNet.gt(sixth)) throw new PayrollLimitError("Sonstiger Bezug übersteigt das Sechstel der laufenden Bezüge: nicht unterstützt (Auflösung in Tarif nötig)");
    if (specialNet.gt(params.tax.specialFreeLimit)) taxSpecial = share(Decimal.max(0, specialNet.minus(params.tax.specialFreeAmount)), params.tax.specialRate);
  }
  const tax = taxRegular.plus(taxSpecial);
  const net = gross.minus(svEmployee).minus(tax);

  // ── Arbeitgeberkosten ──
  const esvb: Breakdown = {};
  let employerSv = D(0);
  if (isMarginal) {
    employerSv = share(regular, params.sv.marginalEmployerRate);
    esvb["Pauschale (geringfügig)"] = s(employerSv);
  } else {
    const e = params.sv.employer;
    const parts: [string, Decimal][] = [["KV", share(svBase, e.kv)], ["PV", share(svBase, e.pv)], ["AV", share(svBase, e.av)], ["UV", share(svBase, e.uv)], ["IESG", share(svBase, e.iesg)], ["WBF", share(svBase, e.wbf)]];
    for (const [k, v] of parts) { esvb[k] = s(v); employerSv = employerSv.plus(v); }
  }
  if (special.gt(0)) {
    const sb = D(Decimal.min(special, params.sv.hbgSpecial)); const e = params.sv.employer;
    const sp = share(sb, e.kv).plus(share(sb, e.pv)).plus(share(sb, e.av)).plus(share(sb, e.uv)).plus(share(sb, e.iesg)).plus(share(sb, e.wbf));
    esvb["Sonderzahlung"] = s(sp); employerSv = employerSv.plus(sp);
  }
  const lv = params.employerLevies;
  const levBase = isMarginal ? D(0) : gross; // Pauschale deckt bei Geringfügigen alles ab (vereinfacht)
  const levies: [string, Decimal][] = [["DB", share(levBase, lv.db)], ["DZ", share(levBase, lv.dz)], ["KommSt", share(levBase, lv.kommst)], ["MVK", share(levBase, lv.mvk)]];
  const levB: Breakdown = {}; let employerLevies = D(0);
  for (const [k, v] of levies) { levB[k] = s(v); employerLevies = employerLevies.plus(v); }

  return {
    regularGross: s(regular), specialGross: s(special), gross: s(gross),
    svEmployee: s(svEmployee), svEmployeeBreakdown: svb,
    taxBase: s(taxBaseMonthly), taxRegular: s(taxRegular), taxSpecial: s(taxSpecial), tax: s(tax),
    net: s(net),
    employerSv: s(employerSv), employerSvBreakdown: esvb, employerLevies: s(employerLevies), employerLeviesBreakdown: levB,
    employerCost: s(gross.plus(employerSv).plus(employerLevies)),
    warnings,
  };
}
