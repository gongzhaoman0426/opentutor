'use client';

import { useParams } from 'next/navigation';
import { CourseEditor } from '@/components/CourseEditor';

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  return <CourseEditor id={params.id} />;
}
