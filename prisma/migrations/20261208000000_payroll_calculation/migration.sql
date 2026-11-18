-- CreateTable
CREATE TABLE "PayrollParamSet" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "params" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "validatedById" TEXT,
    "validatedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollParamSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollTerms" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "validFrom" DATE NOT NULL,
    "monthlyGross" DECIMAL(19,2) NOT NULL,
    "marginal" BOOLEAN NOT NULL DEFAULT false,
    "allowanceMonthly" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "commuterMonthly" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "familyBonusChildren" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollTerms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "paramSetId" TEXT NOT NULL,
    "paramsSnapshot" JSONB NOT NULL,
    "paramsValidated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRunLine" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "employeeNumber" TEXT NOT NULL,
    "employeeName" TEXT NOT NULL,
    "regularExtra" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "special" DECIMAL(19,2) NOT NULL DEFAULT 0,
    "gross" DECIMAL(19,2) NOT NULL,
    "svEmployee" DECIMAL(19,2) NOT NULL,
    "tax" DECIMAL(19,2) NOT NULL,
    "net" DECIMAL(19,2) NOT NULL,
    "employerCost" DECIMAL(19,2) NOT NULL,
    "detail" JSONB NOT NULL,

    CONSTRAINT "PayrollRunLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollParamSet_organizationId_validFrom_idx" ON "PayrollParamSet"("organizationId", "validFrom");

-- CreateIndex
CREATE INDEX "PayrollTerms_organizationId_employeeId_validFrom_idx" ON "PayrollTerms"("organizationId", "employeeId", "validFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRun_organizationId_year_month_version_key" ON "PayrollRun"("organizationId", "year", "month", "version");

-- CreateIndex
CREATE INDEX "PayrollRunLine_organizationId_employeeId_idx" ON "PayrollRunLine"("organizationId", "employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollRunLine_runId_employeeId_key" ON "PayrollRunLine"("runId", "employeeId");

-- AddForeignKey
ALTER TABLE "PayrollRunLine" ADD CONSTRAINT "PayrollRunLine_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Je Monat höchstens ein nicht stornierter Lauf
CREATE UNIQUE INDEX "PayrollRun_one_active" ON "PayrollRun"("organizationId", "year", "month") WHERE "status" <> 'CANCELLED';
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_status_check" CHECK ("status" IN ('DRAFT', 'APPROVED', 'CANCELLED'));

-- Vertragsdaten: append-only (neue Zeile statt Änderung)
CREATE TRIGGER "PayrollTerms_guard" BEFORE UPDATE OR DELETE ON "PayrollTerms" FOR EACH ROW EXECUTE FUNCTION time_journal_guard();

-- Parametersätze: Inhalt unveränderlich, nur die Prüfung (validatedAt/validatedById) darf einmal gesetzt werden
CREATE OR REPLACE FUNCTION payroll_paramset_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.allow_journal_delete', true), '') <> 'on' THEN
      RAISE EXCEPTION 'PayrollParamSet ist unveränderlich (DELETE nicht erlaubt)';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.params IS DISTINCT FROM OLD.params OR NEW."validFrom" <> OLD."validFrom" OR NEW.label <> OLD.label OR NEW.source <> OLD.source OR NEW."organizationId" <> OLD."organizationId" THEN
    RAISE EXCEPTION 'PayrollParamSet ist unveränderlich';
  END IF;
  IF OLD."validatedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PayrollParamSet ist bereits geprüft';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollParamSet_guard" BEFORE UPDATE OR DELETE ON "PayrollParamSet" FOR EACH ROW EXECUTE FUNCTION payroll_paramset_guard();

-- Läufe: freigegebene Läufe sind gesperrt (nur Storno); stornierte unveränderlich
CREATE OR REPLACE FUNCTION payroll_run_guard() RETURNS trigger AS $$
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Freigegebene oder stornierte Abrechnungsläufe dürfen nicht gelöscht werden'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'CANCELLED' THEN RAISE EXCEPTION 'Stornierte Abrechnungsläufe sind unveränderlich'; END IF;
  IF OLD.status = 'APPROVED' AND (NEW.status <> 'CANCELLED' OR NEW."paramsSnapshot" IS DISTINCT FROM OLD."paramsSnapshot") THEN
    RAISE EXCEPTION 'Freigegebene Abrechnungsläufe sind gesperrt (nur Storno)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollRun_guard" BEFORE UPDATE OR DELETE ON "PayrollRun" FOR EACH ROW EXECUTE FUNCTION payroll_run_guard();

CREATE OR REPLACE FUNCTION payroll_line_guard() RETURNS trigger AS $$
DECLARE st text;
BEGIN
  IF coalesce(current_setting('app.allow_journal_delete', true), '') = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  SELECT status INTO st FROM "PayrollRun" WHERE id = OLD."runId";
  IF st IS NOT NULL AND st <> 'DRAFT' THEN RAISE EXCEPTION 'Zeilen freigegebener Abrechnungsläufe sind unveränderlich'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "PayrollRunLine_guard" BEFORE UPDATE OR DELETE ON "PayrollRunLine" FOR EACH ROW EXECUTE FUNCTION payroll_line_guard();
