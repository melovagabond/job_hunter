import { TextareaAutosize, Typography } from '@material-ui/core'
import React from 'react'


export default function Job({job}){
    return (
    <div className={'job'}>
        <Typography>{job.title}</Typography>
        <Typography>{job.company}</Typography>
    </div>
    )
}