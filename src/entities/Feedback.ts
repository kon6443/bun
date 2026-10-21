import 'reflect-metadata';
import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from './User';

export const FEEDBACK_CATEGORIES = ['FEATURE', 'BUG', 'IMPROVEMENT', 'QUESTION', 'OTHER'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ['RECEIVED', 'IN_PROGRESS', 'DONE', 'REJECTED'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * 사용자 피드백 — 스키마: migrations/*-CreateFeedbacks.ts (docs/tasks/feedback DESIGN.md §1)
 *
 * 작성자 본인만 조회하고 작성 후 수정·삭제하지 않는다. STATUS·ADMIN_REPLY는 운영자가 SQL로 갱신한다.
 */
@Entity('FEEDBACKS')
export class Feedback {
  // DB: GENERATED ALWAYS AS IDENTITY — INSERT 시 ID 생략 필수 (명시 값은 ORA-32795 거부)
  @PrimaryGeneratedColumn({ name: 'FEEDBACK_ID' })
  feedbackId: number;

  @Column({ name: 'USER_ID', type: 'number' })
  userId: number;

  // DB CHECK: FEEDBACK_CATEGORIES
  @Column({ name: 'CATEGORY', type: 'varchar2', length: 20 })
  category: FeedbackCategory;

  // 앞뒤 공백 제거 후 1~100자 (400바이트)
  @Column({ name: 'TITLE', type: 'varchar2', length: 400 })
  title: string;

  @Column({ name: 'CONTENT', type: 'clob' })
  content: string;

  // DB CHECK: FEEDBACK_STATUSES, DEFAULT 'RECEIVED'
  @Column({ name: 'STATUS', type: 'varchar2', length: 20, default: 'RECEIVED' })
  status: FeedbackStatus;

  @Column({ name: 'ADMIN_REPLY', type: 'clob', nullable: true })
  adminReply: string | null;

  @Column({ name: 'REPLIED_AT', type: 'timestamp with time zone', nullable: true })
  repliedAt: Date | null;

  @Column({ name: 'PAGE_PATH', type: 'varchar2', length: 2000, nullable: true })
  pagePath: string | null;

  // 서버가 요청 헤더에서 채운다 (500자 절단)
  @Column({ name: 'USER_AGENT', type: 'varchar2', length: 2000, nullable: true })
  userAgent: string | null;

  @Column({ name: 'BUILD_SHA', type: 'varchar2', length: 40, nullable: true })
  buildSha: string | null;

  @Column({ name: 'CRTD_AT', type: 'timestamp with time zone', default: () => 'CURRENT_TIMESTAMP' })
  crtdAt: Date;

  // 운영자의 상태·답변 갱신 시각
  @Column({ name: 'MDFD_AT', type: 'timestamp with time zone', nullable: true })
  mdfdAt: Date | null;

  // 관계
  @ManyToOne(() => User)
  @JoinColumn({ name: 'USER_ID' })
  user: User;
}
