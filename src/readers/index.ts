import type { Reader, ReaderName } from "../types";
import { claudeReader } from "./claude";
import { novaReader } from "./nova";
import { textractReader } from "./textract";
import { gcvReader } from "./gcv";

export const readers: Record<ReaderName, Reader> = {
  claude: claudeReader,
  nova: novaReader,
  textract: textractReader,
  gcv: gcvReader,
};
