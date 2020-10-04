import React from 'react'
import Typography from '@material-ui/core/Typography';
import DialogTitle from '@material-ui/core/DialogTitle';
import Dialog from 'material-ui/core/Dialog';
import Button from 'material-ui/core/Button';

import Job from './Job';



export default function Jobs({jobs}){

    return (
    <div className="jobs">
        <Typography variant="h1">
            Filtered Job Hunt
        </Typography>
        {
            jobs.map(
                (job, i) => <Job key={i} job={job} />
            )
        }
    </div>)
}