import { Loading } from '@paalstack/react-ui';

export default function ProjectLoading() {
  return (
    <div className="flex min-h-[60vh] w-full items-center justify-center">
      <Loading content="Loading project…" spinnerProps={{ size: 'lg' }} />
    </div>
  );
}
