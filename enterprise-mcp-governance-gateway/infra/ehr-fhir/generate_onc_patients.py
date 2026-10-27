#!/usr/bin/env python3
"""
Generate rich FHIR-native ONCOLOGY patient journeys as transaction bundles,
written into this directory as patient-onc-*-bundle.json so the EHR seeder
(seed-onc.sh) picks them up automatically.

Each journey is a time-ordered, cross-linked web of FHIR resources shaped for
what the oncology-chart-synthesis skill reads back through the governed EHR
tools (ehr_fhir_lookup -> Patient + Conditions + MedicationRequests +
Observations; imaging_lookup -> ImagingStudy):

    Patient
      -> Condition(primary cancer dx, ICD-10 + SNOMED, with onset/recorded)
      -> Observation(staging: TNM / stage group / histology grade)
      -> Observation(tumor markers + labs over MULTIPLE dates -> trend)
      -> Procedure(biopsy, surgery, port placement, radiotherapy)
      -> MedicationRequest(systemic therapy lines, active + completed)
      -> ImagingStudy(CT / PET / MRI across the journey)
      -> DiagnosticReport(pathology / radiology impressions)

Dates span months (diagnosis -> treatment -> surveillance) so timelines and
marker trends are real. Fictional (synthetic) data only.

Usage:  python3 generate_onc_patients.py
Output: patient-onc-<slug>-bundle.json  (one per journey)
"""
from __future__ import annotations
import json, pathlib, datetime

OUT = pathlib.Path(__file__).parent
SNOMED = "http://snomed.info/sct"
LOINC = "http://loinc.org"
RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm"
ICD10 = "http://hl7.org/fhir/sid/icd-10-cm"
DCM = "http://dicom.nema.org/resources/ontology/DCM"
CLIN = "http://terminology.hl7.org/CodeSystem/condition-clinical"
VER = "http://terminology.hl7.org/CodeSystem/condition-ver-status"
CAT = "http://terminology.hl7.org/CodeSystem/condition-category"
OBSCAT = "http://terminology.hl7.org/CodeSystem/observation-category"
INTERP = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation"


def d(date_str: str) -> datetime.date:
    return datetime.date.fromisoformat(date_str)


def day(base: datetime.date, offset_days: int) -> str:
    return (base + datetime.timedelta(days=offset_days)).strftime("%Y-%m-%d")


def dt(base: datetime.date, offset_days: int, hour: int = 9) -> str:
    return (base + datetime.timedelta(days=offset_days)).strftime(f"%Y-%m-%dT{hour:02d}:00:00Z")


def make_journey(spec):
    pid = spec["pid"]
    base = d(spec["dx_date"])
    resources = []

    # Patient
    resources.append({
        "resourceType": "Patient", "id": pid,
        "identifier": [{"system": "http://halo.example/mrn", "value": spec["mrn"]}],
        "name": [{"use": "official", "family": spec["family"], "given": [spec["given"]]}],
        "gender": spec["gender"], "birthDate": spec["birthDate"],
    })

    # Primary cancer Condition (ICD-10 + SNOMED), onset before dx, recorded at dx
    resources.append({
        "resourceType": "Condition", "id": f"{pid}-dx",
        "clinicalStatus": {"coding": [{"system": CLIN, "code": spec.get("clinical_status", "active")}]},
        "verificationStatus": {"coding": [{"system": VER, "code": "confirmed"}]},
        "category": [{"coding": [{"system": CAT, "code": "encounter-diagnosis",
                                  "display": "Encounter Diagnosis"}]}],
        "code": {"coding": [
            {"system": ICD10, "code": spec["icd10"], "display": spec["dx_display"]},
            {"system": SNOMED, "code": spec["dx_snomed"], "display": spec["dx_display"]},
        ], "text": spec["dx_display"]},
        "subject": {"reference": f"Patient/{pid}"},
        "onsetDateTime": day(base, -spec.get("onset_before_days", 30)),
        "recordedDate": day(base, 0),
    })

    # Comorbidities / secondary conditions
    for i, c in enumerate(spec.get("comorbidities", [])):
        resources.append({
            "resourceType": "Condition", "id": f"{pid}-cc-{i}",
            "clinicalStatus": {"coding": [{"system": CLIN, "code": "active"}]},
            "category": [{"coding": [{"system": CAT, "code": "problem-list-item",
                                      "display": "Problem List Item"}]}],
            "code": {"coding": [{"system": ICD10, "code": c["icd10"], "display": c["display"]}],
                     "text": c["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "recordedDate": day(base, c.get("day", -200)),
        })

    # Staging / histology Observations (survey category)
    for i, s in enumerate(spec.get("staging", [])):
        resources.append({
            "resourceType": "Observation", "id": f"{pid}-stage-{i}",
            "status": "final",
            "category": [{"coding": [{"system": OBSCAT, "code": "survey", "display": "Survey"}]}],
            "code": {"coding": [{"system": LOINC, "code": s["code"], "display": s["display"]}],
                     "text": s["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "effectiveDateTime": day(base, s.get("day", 2)),
            "valueString": s["value"],
        })

    # Tumor markers + labs over multiple dates (trend)
    for i, m in enumerate(spec.get("markers", [])):
        for j, point in enumerate(m["points"]):
            r = {
                "resourceType": "Observation", "id": f"{pid}-mk-{i}-{j}",
                "status": "final",
                "category": [{"coding": [{"system": OBSCAT, "code": "laboratory",
                                          "display": "Laboratory"}]}],
                "code": {"coding": [{"system": LOINC, "code": m["code"], "display": m["display"]}],
                         "text": m["display"]},
                "subject": {"reference": f"Patient/{pid}"},
                "effectiveDateTime": day(base, point["day"]),
                "valueQuantity": {"value": point["value"], "unit": m["unit"],
                                  "system": "http://unitsofmeasure.org", "code": m["ucum"]},
            }
            if point.get("interp"):
                r["interpretation"] = [{"coding": [{"system": INTERP, "code": point["interp"]}]}]
            resources.append(r)

    # Procedures (biopsy, surgery, port, radiotherapy)
    for i, p in enumerate(spec.get("procedures", [])):
        resources.append({
            "resourceType": "Procedure", "id": f"{pid}-proc-{i}",
            "status": "completed",
            "code": {"coding": [{"system": SNOMED, "code": p["code"], "display": p["display"]}],
                     "text": p["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "performedDateTime": day(base, p["day"]),
        })

    # Systemic therapy MedicationRequests (lines of therapy; active + completed)
    for i, m in enumerate(spec.get("meds", [])):
        resources.append({
            "resourceType": "MedicationRequest", "id": f"{pid}-med-{i}",
            "status": m.get("status", "active"), "intent": "order",
            "medicationCodeableConcept": {"coding": [{"system": RXNORM, "code": m["code"],
                                                      "display": m["display"]}],
                                          "text": m["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "authoredOn": day(base, m["day"]),
            "dosageInstruction": [{"text": m["dose"]}],
        })

    # Imaging studies + their radiology/pathology DiagnosticReports
    for i, im in enumerate(spec.get("imaging", [])):
        img_id = f"{pid}-img-{i}"
        resources.append({
            "resourceType": "ImagingStudy", "id": img_id,
            "status": "available",
            "subject": {"reference": f"Patient/{pid}"},
            "started": dt(base, im["day"]),
            "numberOfSeries": im.get("series", 2),
            "numberOfInstances": im.get("instances", 120),
            "modality": [{"system": DCM, "code": im["modality"]}],
            "description": im["display"],
        })
        resources.append({
            "resourceType": "DiagnosticReport", "id": f"{pid}-dr-{i}",
            "status": "final",
            "category": [{"coding": [{"system": "http://terminology.hl7.org/CodeSystem/v2-0074",
                                      "code": "RAD", "display": "Radiology"}]}],
            "code": {"coding": [{"system": LOINC, "code": im.get("loinc", "18748-4"),
                                 "display": im["display"]}], "text": im["display"]},
            "subject": {"reference": f"Patient/{pid}"},
            "effectiveDateTime": dt(base, im["day"]),
            "issued": dt(base, im["day"]),
            "imagingStudy": [{"reference": f"ImagingStudy/{img_id}"}],
            "conclusion": im["impression"],
        })

    entries = [{"resource": r, "request": {"method": "PUT", "url": f"{r['resourceType']}/{r['id']}"}}
               for r in resources]
    return {"resourceType": "Bundle", "type": "transaction", "entry": entries}


# day offsets are relative to dx_date (0). Negative = before diagnosis,
# positive = after. Markers carry multiple timepoints to form a trend.
JOURNEYS = [
    {
        "pid": "onc-lung-nsclc", "mrn": "ONC-30001", "family": "Alvarez", "given": "Carlos",
        "gender": "male", "birthDate": "1958-02-14", "dx_date": "2026-03-10",
        "icd10": "C34.11", "dx_snomed": "254637007",
        "dx_display": "Malignant neoplasm of right upper lobe, bronchus or lung (NSCLC, adenocarcinoma)",
        "onset_before_days": 45,
        "comorbidities": [
            {"icd10": "J44.9", "display": "COPD", "day": -1400},
            {"icd10": "F17.210", "display": "Nicotine dependence, cigarettes", "day": -3000},
        ],
        "staging": [
            {"code": "21908-9", "display": "Stage group (AJCC)", "value": "Stage IIIB (cT3 N2 M0)", "day": 3},
            {"code": "59847-4", "display": "Histology", "value": "Adenocarcinoma; PD-L1 TPS 60%; EGFR wild-type, ALK negative", "day": 5},
        ],
        "markers": [
            {"code": "2039-6", "display": "CEA", "unit": "ng/mL", "ucum": "ng/mL",
             "points": [{"day": 2, "value": 18.4, "interp": "H"}, {"day": 70, "value": 9.1, "interp": "H"},
                        {"day": 140, "value": 4.2}, {"day": 210, "value": 3.1}]},
        ],
        "procedures": [
            {"code": "432231006", "display": "CT-guided lung biopsy", "day": 1},
            {"code": "77343006", "display": "Mediastinoscopy with lymph node sampling", "day": 7},
            {"code": "399315003", "display": "Radiotherapy to thorax (concurrent)", "day": 30},
        ],
        "meds": [
            {"code": "1657736", "display": "Carboplatin + pemetrexed (chemo)", "dose": "AUC5 + 500 mg/m2 IV q3wk x4",
             "day": 28, "status": "completed"},
            {"code": "1547545", "display": "Durvalumab (consolidation immunotherapy)", "dose": "10 mg/kg IV q2wk",
             "day": 120, "status": "active"},
        ],
        "imaging": [
            {"modality": "CT", "display": "CT chest with contrast", "day": 0, "series": 3, "instances": 280,
             "impression": "4.1 cm RUL mass with ipsilateral mediastinal nodes (N2). No distant disease."},
            {"modality": "PT", "display": "FDG PET/CT", "day": 4, "series": 4, "instances": 420,
             "impression": "Hypermetabolic RUL mass and station 4R/7 nodes; no distant FDG-avid disease."},
            {"modality": "CT", "display": "CT chest (restaging)", "day": 135, "series": 3, "instances": 290,
             "impression": "Partial response: primary mass now 1.8 cm; nodal disease regressed."},
        ],
    },
    {
        "pid": "onc-breast", "mrn": "ONC-30002", "family": "Nakamura", "given": "Yuki",
        "gender": "female", "birthDate": "1972-09-02", "dx_date": "2026-01-22",
        "icd10": "C50.911", "dx_snomed": "254837009",
        "dx_display": "Malignant neoplasm of right female breast (invasive ductal carcinoma)",
        "onset_before_days": 20,
        "comorbidities": [{"icd10": "E03.9", "display": "Hypothyroidism", "day": -900}],
        "staging": [
            {"code": "21908-9", "display": "Stage group (AJCC)", "value": "Stage IIA (pT2 N0 M0)", "day": 10},
            {"code": "59847-4", "display": "Histology/receptors", "value": "Invasive ductal carcinoma, grade 2; ER 95%, PR 80%, HER2 negative; Ki-67 22%", "day": 12},
            {"code": "85337-4", "display": "Oncotype DX recurrence score", "value": "RS 21 (intermediate)", "day": 20},
        ],
        "markers": [
            {"code": "6875-9", "display": "CA 15-3", "unit": "U/mL", "ucum": "U/mL",
             "points": [{"day": 5, "value": 42, "interp": "H"}, {"day": 120, "value": 24}, {"day": 240, "value": 19}]},
        ],
        "procedures": [
            {"code": "122548005", "display": "Core needle biopsy of breast", "day": 2},
            {"code": "392021009", "display": "Lumpectomy with sentinel node biopsy", "day": 25},
            {"code": "399315003", "display": "Adjuvant whole-breast radiotherapy", "day": 120},
        ],
        "meds": [
            {"code": "198240", "display": "Anastrozole (aromatase inhibitor)", "dose": "1 mg PO daily",
             "day": 60, "status": "active"},
        ],
        "imaging": [
            {"modality": "MG", "display": "Diagnostic mammogram", "day": -5, "series": 2, "instances": 8,
             "impression": "2.4 cm spiculated mass right breast, BI-RADS 5."},
            {"modality": "MR", "display": "Breast MRI", "day": 3, "series": 5, "instances": 600,
             "impression": "Unifocal 2.3 cm enhancing mass; no additional lesions; nodes unremarkable."},
        ],
    },
    {
        "pid": "onc-colon", "mrn": "ONC-30003", "family": "Oyelaran", "given": "Ade",
        "gender": "male", "birthDate": "1965-07-19", "dx_date": "2025-11-14",
        "icd10": "C18.7", "dx_snomed": "363406005",
        "dx_display": "Malignant neoplasm of sigmoid colon (adenocarcinoma)",
        "onset_before_days": 60,
        "comorbidities": [{"icd10": "E11.9", "display": "Type 2 diabetes mellitus", "day": -1800}],
        "staging": [
            {"code": "21908-9", "display": "Stage group (AJCC)", "value": "Stage IV (pT3 N1 M1 - liver metastases)", "day": 15},
            {"code": "59847-4", "display": "Molecular", "value": "KRAS G12D mutant, BRAF wild-type, MSS", "day": 20},
        ],
        "markers": [
            {"code": "2039-6", "display": "CEA", "unit": "ng/mL", "ucum": "ng/mL",
             "points": [{"day": 3, "value": 142, "interp": "H"}, {"day": 90, "value": 48, "interp": "H"},
                        {"day": 180, "value": 31, "interp": "H"}, {"day": 300, "value": 58, "interp": "H"}]},
        ],
        "procedures": [
            {"code": "73761001", "display": "Colonoscopy with biopsy", "day": 0},
            {"code": "26390003", "display": "Sigmoid colectomy", "day": 25},
            {"code": "55705006", "display": "Port-a-cath placement", "day": 35},
        ],
        "meds": [
            {"code": "1736854", "display": "FOLFOX (5-FU + leucovorin + oxaliplatin)", "dose": "q2wk x12 cycles",
             "day": 40, "status": "completed"},
            {"code": "1657793", "display": "Bevacizumab", "dose": "5 mg/kg IV q2wk", "day": 40, "status": "completed"},
            {"code": "1726319", "display": "FOLFIRI (second line)", "dose": "q2wk", "day": 310, "status": "active"},
        ],
        "imaging": [
            {"modality": "CT", "display": "CT abdomen/pelvis", "day": 5, "series": 3, "instances": 340,
             "impression": "Sigmoid mass with 3 hepatic metastases (largest 4.2 cm)."},
            {"modality": "CT", "display": "CT abdomen (restaging)", "day": 185, "series": 3, "instances": 330,
             "impression": "Partial response: hepatic lesions decreased ~40%."},
            {"modality": "CT", "display": "CT abdomen (surveillance)", "day": 300, "series": 3, "instances": 335,
             "impression": "Progression: new hepatic lesion; rising CEA. Second-line therapy indicated."},
        ],
    },
    {
        "pid": "onc-prostate", "mrn": "ONC-30004", "family": "Haddad", "given": "Samir",
        "gender": "male", "birthDate": "1954-03-08", "dx_date": "2026-02-02",
        "icd10": "C61", "dx_snomed": "399068003",
        "dx_display": "Malignant neoplasm of prostate (adenocarcinoma)",
        "onset_before_days": 90,
        "comorbidities": [{"icd10": "I10", "display": "Essential hypertension", "day": -2000}],
        "staging": [
            {"code": "21908-9", "display": "Stage group", "value": "cT2c N0 M0; Gleason 4+3=7 (Grade Group 3)", "day": 8},
            {"code": "59847-4", "display": "Risk group", "value": "NCCN unfavorable intermediate risk", "day": 10},
        ],
        "markers": [
            {"code": "2857-1", "display": "PSA", "unit": "ng/mL", "ucum": "ng/mL",
             "points": [{"day": -10, "value": 12.6, "interp": "H"}, {"day": 60, "value": 2.1},
                        {"day": 150, "value": 0.4}, {"day": 270, "value": 0.1}]},
        ],
        "procedures": [
            {"code": "76164006", "display": "Transrectal prostate biopsy", "day": 0},
            {"code": "399315003", "display": "External beam radiotherapy to prostate", "day": 45},
        ],
        "meds": [
            {"code": "1000048", "display": "Leuprolide (ADT)", "dose": "22.5 mg IM q3mo", "day": 20, "status": "active"},
        ],
        "imaging": [
            {"modality": "MR", "display": "Multiparametric prostate MRI", "day": -3, "series": 6, "instances": 480,
             "impression": "PI-RADS 5 lesion left peripheral zone; no extracapsular extension."},
            {"modality": "NM", "display": "PSMA PET/CT", "day": 6, "series": 4, "instances": 410,
             "impression": "PSMA-avid prostate lesion; no nodal or distant disease."},
        ],
    },
    {
        "pid": "onc-lymphoma", "mrn": "ONC-30005", "family": "Petrova", "given": "Irina",
        "gender": "female", "birthDate": "1990-12-30", "dx_date": "2026-04-18",
        "icd10": "C83.30", "dx_snomed": "109979007",
        "dx_display": "Diffuse large B-cell lymphoma, unspecified site",
        "onset_before_days": 40,
        "comorbidities": [],
        "staging": [
            {"code": "21908-9", "display": "Ann Arbor stage", "value": "Stage III-B (B symptoms present); IPI 2", "day": 12},
            {"code": "59847-4", "display": "Pathology", "value": "DLBCL, germinal-center B-cell type; CD20+, MYC/BCL2 double-expressor", "day": 14},
        ],
        "markers": [
            {"code": "14804-9", "display": "LDH", "unit": "U/L", "ucum": "U/L",
             "points": [{"day": 5, "value": 420, "interp": "H"}, {"day": 60, "value": 260, "interp": "H"},
                        {"day": 150, "value": 190}]},
        ],
        "procedures": [
            {"code": "174184006", "display": "Excisional lymph node biopsy", "day": 0},
            {"code": "234336002", "display": "Bone marrow aspirate and biopsy", "day": 10},
        ],
        "meds": [
            {"code": "1657741", "display": "R-CHOP (rituximab + cyclophosphamide + doxorubicin + vincristine + prednisone)",
             "dose": "q3wk x6 cycles", "day": 18, "status": "active"},
        ],
        "imaging": [
            {"modality": "PT", "display": "FDG PET/CT (staging)", "day": 8, "series": 4, "instances": 450,
             "impression": "FDG-avid nodal disease above and below diaphragm; spleen involved. Deauville N/A (baseline)."},
            {"modality": "PT", "display": "FDG PET/CT (interim)", "day": 70, "series": 4, "instances": 440,
             "impression": "Marked metabolic response, Deauville 2. Good interim response."},
        ],
    },
    {
        "pid": "onc-pancreas", "mrn": "ONC-30006", "family": "Diallo", "given": "Fatou",
        "gender": "female", "birthDate": "1961-05-21", "dx_date": "2026-05-30",
        "icd10": "C25.0", "dx_snomed": "372142002",
        "dx_display": "Malignant neoplasm of head of pancreas (ductal adenocarcinoma)",
        "onset_before_days": 35,
        "comorbidities": [{"icd10": "K86.1", "display": "Chronic pancreatitis", "day": -600}],
        "staging": [
            {"code": "21908-9", "display": "Stage group", "value": "Borderline resectable (cT3 N1 M0)", "day": 10},
            {"code": "59847-4", "display": "Molecular", "value": "No targetable alteration; germline BRCA wild-type", "day": 15},
        ],
        "markers": [
            {"code": "24108-3", "display": "CA 19-9", "unit": "U/mL", "ucum": "U/mL",
             "points": [{"day": 3, "value": 890, "interp": "H"}, {"day": 75, "value": 310, "interp": "H"},
                        {"day": 160, "value": 140, "interp": "H"}]},
        ],
        "procedures": [
            {"code": "386817006", "display": "EUS-guided fine needle aspiration of pancreas", "day": 0},
            {"code": "73307004", "display": "Biliary stent placement (ERCP)", "day": 6},
        ],
        "meds": [
            {"code": "1736776", "display": "FOLFIRINOX (neoadjuvant)", "dose": "q2wk x6 cycles",
             "day": 20, "status": "active"},
        ],
        "imaging": [
            {"modality": "CT", "display": "Pancreas-protocol CT", "day": 2, "series": 4, "instances": 360,
             "impression": "3.3 cm pancreatic head mass abutting SMV <180 deg; borderline resectable; 1 regional node."},
            {"modality": "CT", "display": "Pancreas-protocol CT (restaging)", "day": 150, "series": 4, "instances": 360,
             "impression": "Decrease in mass size and SMV contact; CA 19-9 falling. Re-evaluate for resection."},
        ],
    },
]


def main():
    for spec in JOURNEYS:
        bundle = make_journey(spec)
        out = OUT / f"patient-{spec['pid']}-bundle.json"
        out.write_text(json.dumps(bundle, indent=2))
        n = len(bundle["entry"])
        print(f"  wrote {out.name}  ({n} resources)  {spec['given']} {spec['family']} - {spec['dx_display']}")


if __name__ == "__main__":
    main()
