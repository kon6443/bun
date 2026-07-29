import "reflect-metadata";
import { Entity, Column, PrimaryColumn } from "typeorm";

@Entity("FILE_SHARES")
export class FileShare {
  @PrimaryColumn({ name: "SHARE_ID", type: "varchar2", length: 255 })
  shareId: string;

  @Column({ name: "API_KEY", type: "varchar2", length: 255 })
  apiKey: string;
}

