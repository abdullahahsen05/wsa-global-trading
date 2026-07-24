import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { CertificateDto } from "@/lib/services/certificateService";

function centeredX(text: string, size: number, width: number, font: { widthOfTextAtSize(value: string, fontSize: number): number }) {
  return (width - font.widthOfTextAtSize(text, size)) / 2;
}

export async function generateEvaluationCertificatePdf(
  certificate: CertificateDto,
  verificationBaseUrl: string,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`WSA Global Certificate — ${certificate.holderName}`);
  pdf.setAuthor("WSA Global");
  pdf.setSubject(`Verified ${certificate.programName} certification`);
  pdf.setKeywords(["WSA Global", "trading", "evaluation", "certificate"]);

  const page = pdf.addPage([842, 595]);
  const { width, height } = page.getSize();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0.035, 0.04, 0.045);
  const panel = rgb(0.065, 0.07, 0.075);
  const gold = rgb(1, 0.82, 0);
  const white = rgb(0.96, 0.96, 0.94);
  const muted = rgb(0.63, 0.64, 0.61);

  page.drawRectangle({ x: 0, y: 0, width, height, color: black });
  page.drawRectangle({ x: 24, y: 24, width: width - 48, height: height - 48, borderColor: gold, borderWidth: 2 });
  page.drawRectangle({ x: 35, y: 35, width: width - 70, height: height - 70, borderColor: rgb(0.25, 0.23, 0.1), borderWidth: 1 });
  page.drawRectangle({ x: 70, y: 70, width: width - 140, height: height - 140, color: panel });

  page.drawRectangle({ x: width / 2 - 28, y: height - 112, width: 56, height: 56, color: gold });
  page.drawText("W", { x: width / 2 - 16, y: height - 99, size: 34, font: bold, color: black });

  const brand = "WSA GLOBAL";
  page.drawText(brand, { x: centeredX(brand, 18, width, bold), y: height - 140, size: 18, font: bold, color: white });
  const eyebrow = "CERTIFICATE OF TRADING EVALUATION";
  page.drawText(eyebrow, { x: centeredX(eyebrow, 11, width, bold), y: height - 177, size: 11, font: bold, color: gold });

  const presented = "THIS CERTIFICATE IS PRESENTED TO";
  page.drawText(presented, { x: centeredX(presented, 9, width, regular), y: height - 220, size: 9, font: regular, color: muted });
  page.drawText(certificate.holderName, {
    x: centeredX(certificate.holderName, 30, width, bold),
    y: height - 267,
    size: 30,
    font: bold,
    color: white,
  });
  page.drawLine({ start: { x: 180, y: height - 278 }, end: { x: width - 180, y: height - 278 }, thickness: 1, color: gold });

  const completion = "for successfully meeting every programmed target in";
  page.drawText(completion, { x: centeredX(completion, 12, width, regular), y: height - 316, size: 12, font: regular, color: muted });
  page.drawText(certificate.programName, {
    x: centeredX(certificate.programName, 21, width, bold),
    y: height - 353,
    size: 21,
    font: bold,
    color: gold,
  });

  const issued = `Issued ${new Date(certificate.issuedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric", timeZone: "UTC" })}`;
  page.drawText(issued, { x: 110, y: 126, size: 10, font: regular, color: muted });
  page.drawText(`Verification ID: ${certificate.verificationId}`, { x: 110, y: 105, size: 10, font: bold, color: white });
  const verifyUrl = `${verificationBaseUrl.replace(/\/$/, "")}/certificates/verify/${certificate.verificationId}`;
  page.drawText(verifyUrl, { x: 110, y: 84, size: 8, font: regular, color: muted });

  page.drawLine({ start: { x: width - 285, y: 116 }, end: { x: width - 105, y: 116 }, thickness: 1, color: gold });
  page.drawText("WSA Global Certification", { x: width - 265, y: 97, size: 10, font: bold, color: white });
  page.drawText("Digitally verifiable record", { x: width - 252, y: 80, size: 8, font: regular, color: muted });

  return pdf.save();
}
