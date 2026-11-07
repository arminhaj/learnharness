import { SumCodingExercise } from "@/components/sum-coding-exercise";

export default function PythonDemoPage() {
	return <SumCodingExercise language="Python 3.11+" problemCallId="python-sum" referenceNote="Python integers have arbitrary precision, so a sum beyond the 64-bit range still works. Keep the function returning an int." />;
}
